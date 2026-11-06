package com.leo.lookask

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream

/**
 * 平板版外壳：全屏 WebView 跑和桌面版同一份渲染进程（assets/www），
 * 系统能力经 GlintNative（NativeBridge）转发，手柄事件由 JoyInput 在进 WebView 之前截下来。
 */
class MainActivity : Activity() {
    lateinit var web: WebView
    private lateinit var native: NativeBridge
    private lateinit var joy: JoyInput
    private lateinit var uvc: UvcCamera
    private var pendingWebPerm: PermissionRequest? = null
    val isDebuggable: Boolean get() = applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        // 只有调试包开网页调试端口
        WebView.setWebContentsDebuggingEnabled(isDebuggable)

        web = WebView(this)
        setContentView(web)
        immersive()
        highRefresh()

        joy = JoyInput(this) { emit(it) }
        uvc = UvcCamera(this) { emit(it) }
        native = NativeBridge(this, joy, uvc) { emit(it) }

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            setSupportZoom(false)
            textZoom = 100
        }
        web.addJavascriptInterface(native, "GlintNative")
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, req: WebResourceRequest): WebResourceResponse? {
                if (req.url.host != HOST) return null
                // 这里抛异常会带崩整个 App
                return try {
                    serve(req.url)
                } catch (e: Exception) {
                    Log.e("GlintWeb", "请求出错 ${req.url.path}", e)
                    WebResourceResponse("text/plain", "utf-8", 500, "Error", emptyMap(), "".byteInputStream())
                }
            }

            /** 页面进程崩了不带崩 App，重新建一遍 */
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                Log.e("GlintWeb", "页面进程退出 crash=${detail.didCrash()}")
                recreate()
                return true
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread { handleWebPermission(request) }
            }

            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                Log.d("GlintWeb", "${m.messageLevel()} ${m.message()} @${m.sourceId()}:${m.lineNumber()}")
                return true
            }
        }
        web.loadUrl("https://$HOST/index.html")
    }

    /** 页面、模型、wasm 从 assets/www 出；用户打开的文件从内部存储 picked/ 出 */
    private fun serve(uri: Uri): WebResourceResponse {
        val path = (uri.path ?: "/").trimStart('/').ifEmpty { "index.html" }
        if (path == "uvc/frame") return uvcFrame(uri)
        val mime = MIME[path.substringAfterLast('.', "").lowercase()] ?: "application/octet-stream"
        return try {
            val stream = if (path.startsWith("picked/")) {
                val root = File(filesDir, "picked").canonicalFile
                val f = File(filesDir, path).canonicalFile
                require(f.path.startsWith(root.path))
                FileInputStream(f)
            } else {
                assets.open("www/$path")
            }
            WebResourceResponse(mime, null, stream)
        } catch (e: Exception) {
            WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), "".byteInputStream())
        }
    }

    /** Glint Eye 的最新一帧：after 是页面已经拿到的序号，没有新帧就等（在 WebView 的 IO 线程上，不卡界面） */
    private fun uvcFrame(uri: Uri): WebResourceResponse {
        val after = uri.getQueryParameter("after")?.toLongOrNull() ?: 0
        val hit = uvc.awaitFrame(after)
        val headers = mapOf("Cache-Control" to "no-store", "X-Seq" to (hit?.first ?: after).toString())
        return if (hit == null) WebResourceResponse("text/plain", null, 204, "No Content", headers, "".byteInputStream())
        else WebResourceResponse("image/jpeg", null, 200, "OK", headers, hit.second.inputStream())
    }

    private fun handleWebPermission(req: PermissionRequest) {
        val need = mutableListOf<String>()
        if (req.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) need += Manifest.permission.CAMERA
        if (req.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) need += Manifest.permission.RECORD_AUDIO
        val missing = need.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isEmpty()) {
            req.grant(req.resources)
            return
        }
        pendingWebPerm?.deny()
        pendingWebPerm = req
        requestPermissions(missing.toTypedArray(), REQ_PERM)
    }

    override fun onRequestPermissionsResult(code: Int, perms: Array<out String>, results: IntArray) {
        if (code != REQ_PERM) return
        val req = pendingWebPerm ?: return
        pendingWebPerm = null
        if (results.isNotEmpty() && results.all { it == PackageManager.PERMISSION_GRANTED }) req.grant(req.resources) else req.deny()
    }

    /** 把事件推给页面：JSON 本身就是合法的 JS 字面量 */
    fun emit(json: JSONObject) {
        val js = "window.__glint&&window.__glint($json)"
        web.post { web.evaluateJavascript(js, null) }
    }

    override fun dispatchKeyEvent(ev: KeyEvent): Boolean = joy.onKey(ev) || super.dispatchKeyEvent(ev)

    override fun dispatchGenericMotionEvent(ev: MotionEvent): Boolean = joy.onMotion(ev) || super.dispatchGenericMotionEvent(ev)

    override fun onResume() {
        super.onResume()
        immersive()
        joy.start()
    }

    override fun onPause() {
        joy.stop()
        super.onPause()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) immersive()
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == REQ_PICK) native.onPicked(if (resultCode == RESULT_OK) data?.data else null)
    }

    @Deprecated("返回键不退出，退到后台，避免丢掉正在读的内容")
    override fun onBackPressed() {
        moveTaskToBack(true)
    }

    /** WebView 默认被系统压在 60Hz：主动要高刷，上限 120Hz（系统设置里的峰值），省得 144Hz 白耗电 */
    private fun highRefresh() {
        val d = display ?: return
        val cur = d.mode
        val best = d.supportedModes
            .filter { it.physicalWidth == cur.physicalWidth && it.physicalHeight == cur.physicalHeight && it.refreshRate <= 121f }
            .maxByOrNull { it.refreshRate } ?: return
        window.attributes = window.attributes.apply { preferredDisplayModeId = best.modeId }
    }

    private fun immersive() {
        window.insetsController?.apply {
            hide(WindowInsets.Type.systemBars())
            systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    fun openSystemSettings(pane: String) {
        val intent = if (pane == "bluetooth") {
            Intent(Settings.ACTION_BLUETOOTH_SETTINGS)
        } else {
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))
        }
        startActivity(intent)
    }

    companion object {
        const val HOST = "appassets.androidplatform.net"
        const val REQ_PERM = 1
        const val REQ_PICK = 2
        val MIME = mapOf(
            "html" to "text/html", "js" to "text/javascript", "mjs" to "text/javascript", "css" to "text/css",
            "json" to "application/json", "wasm" to "application/wasm", "svg" to "image/svg+xml", "png" to "image/png",
            "jpg" to "image/jpeg", "webp" to "image/webp", "woff2" to "font/woff2", "ttf" to "font/ttf", "pdf" to "application/pdf",
            "md" to "text/plain", "markdown" to "text/plain", "txt" to "text/plain"
        )
    }
}
