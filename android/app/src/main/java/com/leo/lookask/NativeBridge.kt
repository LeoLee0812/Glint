package com.leo.lookask

import android.Manifest
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Rect
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Base64
import android.view.PixelCopy
import android.webkit.JavascriptInterface
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Dns
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.net.Inet6Address
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/** 页面里的 window.GlintNative：文件、网络（流式 HTTP / WebSocket）、截图、权限。垫片在 src/renderer/src/android/install.ts */
class NativeBridge(
    private val act: MainActivity,
    private val joy: JoyInput,
    private val uvc: UvcCamera,
    private val emit: (JSONObject) -> Unit
) {
    private val http = OkHttpClient.Builder()
        // 手机热点这类网络的 IPv6 常常解析得到、连不上，OkHttp 要等满超时才换 IPv4（实测首个请求卡 35 秒）：优先 IPv4，单个地址最多等 8 秒
        .dns(object : Dns {
            override fun lookup(hostname: String) = Dns.SYSTEM.lookup(hostname).sortedBy { it is Inet6Address }
        })
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS) // 大模型思考时可能很久没有字节
        .build()
    private val calls = ConcurrentHashMap<String, Call>()
    private val sockets = ConcurrentHashMap<String, WebSocket>()
    private var pickReq: String? = null
    private val dataDir: File get() = act.filesDir

    private fun ev(t: String, vararg kv: Pair<String, Any?>) =
        JSONObject().put("t", t).also { o -> kv.forEach { (k, v) -> o.put(k, v ?: JSONObject.NULL) } }

    private fun safe(name: String) = File(dataDir, File(name).name)

    @JavascriptInterface
    fun readFile(name: String): String? = safe(name).takeIf { it.exists() }?.readText()

    @JavascriptInterface
    fun writeFile(name: String, text: String) {
        safe(name).writeText(text)
    }

    @JavascriptInterface
    fun deleteFile(name: String) {
        safe(name).delete()
    }

    // ---------- HTTP ----------

    @JavascriptInterface
    fun httpStart(id: String, url: String, method: String, headers: String, body: String?) {
        try {
            val b = Request.Builder().url(url)
            val h = JSONObject(headers)
            for (k in h.keys()) b.header(k, h.getString(k))
            val type = (if (h.has("content-type")) h.getString("content-type") else "application/json").toMediaTypeOrNull()
            b.method(method, body?.toByteArray()?.toRequestBody(type))
            val call = http.newCall(b.build())
            calls[id] = call
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    calls.remove(id)
                    emit(ev("http", "id" to id, "phase" to "error", "error" to (e.message ?: "网络错误")))
                }

                override fun onResponse(call: Call, response: Response) {
                    response.use { res ->
                        val hs = JSONObject()
                        for (name in res.headers.names()) hs.put(name, res.header(name))
                        emit(ev("http", "id" to id, "phase" to "head", "status" to res.code, "headers" to hs))
                        try {
                            val src = res.body!!.byteStream()
                            val buf = ByteArray(16 * 1024)
                            while (true) {
                                val n = src.read(buf)
                                if (n < 0) break
                                emit(ev("http", "id" to id, "phase" to "chunk", "b64" to Base64.encodeToString(buf, 0, n, Base64.NO_WRAP)))
                            }
                            emit(ev("http", "id" to id, "phase" to "end"))
                        } catch (e: IOException) {
                            emit(ev("http", "id" to id, "phase" to "error", "error" to (e.message ?: "连接断了")))
                        } finally {
                            calls.remove(id)
                        }
                    }
                }
            })
        } catch (e: Exception) {
            emit(ev("http", "id" to id, "phase" to "error", "error" to (e.message ?: "请求出错")))
        }
    }

    @JavascriptInterface
    fun httpAbort(id: String) {
        calls.remove(id)?.cancel()
    }

    // ---------- WebSocket（百炼语音识别） ----------

    @JavascriptInterface
    fun wsOpen(id: String, url: String, headers: String) {
        val b = Request.Builder().url(url)
        val h = JSONObject(headers)
        for (k in h.keys()) b.header(k, h.getString(k))
        sockets[id] = http.newWebSocket(b.build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                emit(ev("ws", "id" to id, "phase" to "open"))
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                emit(ev("ws", "id" to id, "phase" to "text", "text" to text))
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                sockets.remove(id)
                emit(ev("ws", "id" to id, "phase" to "closed"))
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                sockets.remove(id)
                emit(ev("ws", "id" to id, "phase" to "closed", "error" to (t.message ?: "连接失败")))
            }
        })
    }

    @JavascriptInterface
    fun wsSend(id: String, text: String) {
        sockets[id]?.send(text)
    }

    @JavascriptInterface
    fun wsSendB64(id: String, b64: String) {
        sockets[id]?.send(Base64.decode(b64, Base64.NO_WRAP).toByteString())
    }

    @JavascriptInterface
    fun wsClose(id: String) {
        sockets.remove(id)?.close(1000, null)
    }

    // ---------- 文件 ----------

    @JavascriptInterface
    fun pickFile(reqId: String) {
        pickReq = reqId
        val i = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/pdf", "text/markdown", "text/plain", "application/octet-stream"))
        }
        act.runOnUiThread { act.startActivityForResult(i, MainActivity.REQ_PICK) }
    }

    /** 选中的文件拷进内部存储 picked/，页面按同源地址读（大 PDF 不走 JS 桥） */
    fun onPicked(uri: Uri?) {
        val req = pickReq ?: return
        pickReq = null
        if (uri == null) {
            emit(ev("file", "reqId" to req))
            return
        }
        Thread {
            try {
                var name = "file"
                act.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
                    if (it.moveToFirst()) name = it.getString(0) ?: name
                }
                val dir = File(dataDir, "picked").also { d -> d.deleteRecursively(); d.mkdirs() }
                val sub = File(dir, UUID.randomUUID().toString()).also { it.mkdirs() }
                val out = File(sub, "doc." + name.substringAfterLast('.', "bin"))
                act.contentResolver.openInputStream(uri)!!.use { i -> out.outputStream().use { o -> i.copyTo(o) } }
                emit(ev("file", "reqId" to req, "name" to name, "url" to "/picked/${sub.name}/${out.name}"))
            } catch (e: Exception) {
                emit(ev("file", "reqId" to req))
            }
        }.start()
    }

    /** 导出存到「下载」目录，返回给页面提示用的路径 */
    @JavascriptInterface
    fun saveText(name: String, text: String): String? {
        return try {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, "text/markdown")
            }
            val r = act.contentResolver
            val uri = r.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return null
            r.openOutputStream(uri)!!.use { it.write(text.toByteArray()) }
            "下载/$name"
        } catch (e: Exception) {
            null
        }
    }

    // ---------- 窗口 ----------

    /** 截页面的一块（CSS 像素）。用 PixelCopy：WebGL 和 PDF 画布都截得到 */
    @JavascriptInterface
    fun capture(reqId: String, x: Double, y: Double, w: Double, h: Double) {
        act.runOnUiThread {
            val d = act.resources.displayMetrics.density * act.web.scaleX
            val rect = Rect((x * d).toInt(), (y * d).toInt(), ((x + w) * d).toInt(), ((y + h) * d).toInt())
            rect.intersect(0, 0, act.web.width, act.web.height)
            if (rect.isEmpty) {
                emit(ev("capture", "reqId" to reqId, "dataUrl" to null))
                return@runOnUiThread
            }
            val bmp = Bitmap.createBitmap(rect.width(), rect.height(), Bitmap.Config.ARGB_8888)
            PixelCopy.request(act.window, rect, bmp, { result ->
                Thread {
                    val data = if (result == PixelCopy.SUCCESS) {
                        val out = ByteArrayOutputStream()
                        bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
                        "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
                    } else null
                    emit(ev("capture", "reqId" to reqId, "dataUrl" to data))
                }.start()
            }, Handler(Looper.getMainLooper()))
        }
    }

    @JavascriptInterface
    fun debuggable(): Boolean = act.isDebuggable

    @JavascriptInterface
    fun uvcOpen(reqId: String) {
        act.runOnUiThread { uvc.open(reqId) }
    }

    @JavascriptInterface
    fun uvcPresent(): Boolean = uvc.present()

    @JavascriptInterface
    fun uvcClose() {
        Thread { uvc.close() }.start()
    }

    @JavascriptInterface
    fun bridge(json: String) = joy.command(JSONObject(json))

    @JavascriptInterface
    fun openSettings(pane: String) {
        act.runOnUiThread { act.openSystemSettings(pane) }
    }

    @JavascriptInterface
    fun permStatus(): String {
        fun st(p: String) = if (act.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED) "granted" else "not-determined"
        return JSONObject().put("camera", st(Manifest.permission.CAMERA)).put("microphone", st(Manifest.permission.RECORD_AUDIO)).toString()
    }

    @JavascriptInterface
    fun display(): String {
        val m = act.resources.displayMetrics
        return JSONObject()
            .put("id", 0)
            .put("mmW", m.widthPixels / m.xdpi * 25.4)
            .put("mmH", m.heightPixels / m.ydpi * 25.4)
            .put("ptW", m.widthPixels / m.density)
            .put("ptH", m.heightPixels / m.density)
            .put("measured", true)
            .toString()
    }

    @JavascriptInterface
    fun moveToBack() {
        act.runOnUiThread { act.moveTaskToBack(true) }
    }
}
