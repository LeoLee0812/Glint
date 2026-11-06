package com.leo.lookask

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.util.Log
import com.sun.jna.Library
import com.sun.jna.Memory
import com.sun.jna.Native
import com.sun.jna.NativeLong
import com.sun.jna.Pointer
import com.sun.jna.ptr.PointerByReference
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/**
 * 用户态 UVC 驱动：这台平板的系统没有外接摄像头支持（Camera2 和 WebView 都看不到 USB 摄像头），
 * Glint Eye 只能由 App 自己读。流程：UsbManager 拿权限 → 解析描述符选格式 → PROBE/COMMIT 协商 → 切 alt setting →
 * 经 usbfs ioctl 收等时传输（Java 的 USB 接口没有等时，用 JNA 调 ioctl，省掉 NDK）→ 拼成一帧帧 JPEG，页面从 /uvc/frame 取。
 */
class UvcCamera(private val ctx: Context, private val emit: (JSONObject) -> Unit) {
    private interface LibC : Library {
        fun ioctl(fd: Int, request: NativeLong, arg: Pointer?): Int
        fun ioctl(fd: Int, request: NativeLong, arg: PointerByReference): Int
    }

    private class FrameFmt(val mjpeg: Boolean, val formatIndex: Int, val frameIndex: Int, val w: Int, val h: Int, val interval: Int)

    private val usb = ctx.getSystemService(UsbManager::class.java)
    private val libc: LibC by lazy { Native.load("c", LibC::class.java) }
    private val lock = Object()
    private var latest: ByteArray? = null
    private var latestSeq = 0L
    @Volatile private var running = false
    private var worker: Thread? = null
    private var conn: UsbDeviceConnection? = null
    private var streamIf: UsbInterface? = null
    private var pendingReq: String? = null

    private val permAction = ctx.packageName + ".USB_PERMISSION"
    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            when (i.action) {
                permAction -> {
                    val req = pendingReq ?: return
                    pendingReq = null
                    val dev = i.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
                    if (dev != null && i.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)) start(req, dev)
                    else result(req, "denied")
                }
                UsbManager.ACTION_USB_DEVICE_ATTACHED -> emit(JSONObject().put("t", "uvc_attached"))
                UsbManager.ACTION_USB_DEVICE_DETACHED -> {
                    val dev = i.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
                    if (dev != null && isCamera(dev)) {
                        close()
                        emit(JSONObject().put("t", "uvc_detached"))
                    }
                }
            }
        }
    }

    init {
        val f = IntentFilter(permAction).apply {
            addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
            addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
        }
        ctx.registerReceiver(receiver, f, Context.RECEIVER_EXPORTED)
    }

    private fun isCamera(d: UsbDevice) = (0 until d.interfaceCount).any { d.getInterface(it).interfaceClass == UsbConstants.USB_CLASS_VIDEO }

    private fun result(req: String, state: String, w: Int = 0, h: Int = 0, error: String? = null) {
        emit(JSONObject().put("t", "uvc").put("reqId", req).put("state", state).put("w", w).put("h", h).put("error", error ?: ""))
    }

    /** 有没有插着 USB 摄像头（不需要权限） */
    fun present() = usb.deviceList.values.any { isCamera(it) }

    fun open(req: String) {
        close()
        val dev = usb.deviceList.values.firstOrNull { isCamera(it) }
        when {
            dev == null -> result(req, "none")
            usb.hasPermission(dev) -> start(req, dev)
            else -> {
                pendingReq = req
                val pi = PendingIntent.getBroadcast(
                    ctx, 0, Intent(permAction).setPackage(ctx.packageName),
                    PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
                )
                usb.requestPermission(dev, pi)
            }
        }
    }

    private fun start(req: String, dev: UsbDevice) {
        try {
            val c = usb.openDevice(dev) ?: return result(req, "error", error = "打不开设备")
            conn = c
            val raw = c.rawDescriptors ?: return result(req, "error", error = "读不到描述符")
            val (vsNumber, formats) = parseDescriptors(raw)
            val fmt = pick(formats) ?: return result(req, "error", error = "没有可用的视频格式")
            Log.d(TAG, "${dev.productName} 格式 ${formats.map { "${if (it.mjpeg) "MJPEG" else "YUY2"} ${it.w}x${it.h}@${10_000_000 / it.interval}" }}")
            val alts = (0 until dev.interfaceCount).map { dev.getInterface(it) }.filter { it.id == vsNumber }
            val base = alts.first { it.alternateSetting == 0 }
            dev.let { d ->
                (0 until d.interfaceCount).map { d.getInterface(it) }
                    .filter { it.interfaceClass == UsbConstants.USB_CLASS_VIDEO && it.alternateSetting == 0 }
                    .forEach { c.claimInterface(it, true) }
            }
            streamIf = base
            val payload = negotiate(c, vsNumber, fmt)
            // 带宽够放下一个载荷的最小 alt setting
            val alt = alts.filter { it.endpointCount > 0 }.sortedBy { packetBytes(it.getEndpoint(0)) }
                .let { list -> list.firstOrNull { packetBytes(it.getEndpoint(0)) >= payload } ?: list.lastOrNull() }
                ?: return result(req, "error", error = "没有等时端点")
            val ep = alt.getEndpoint(0)
            if (!c.setInterface(alt)) return result(req, "error", error = "切换 alt setting 失败")
            Log.d(TAG, "选 ${fmt.w}x${fmt.h} mjpeg=${fmt.mjpeg} payload=$payload alt=${alt.alternateSetting} packet=${packetBytes(ep)}")
            running = true
            worker = Thread({ pump(c, ep, fmt) }, "uvc-pump").also { it.priority = Thread.MAX_PRIORITY; it.start() }
            result(req, "open", fmt.w, fmt.h)
        } catch (e: Exception) {
            Log.w(TAG, "打开失败", e)
            result(req, "error", error = e.message ?: e.toString())
        }
    }

    private fun packetBytes(ep: UsbEndpoint): Int {
        val m = ep.maxPacketSize
        return (m and 0x7FF) * (1 + ((m shr 11) and 3))
    }

    private fun parseDescriptors(d: ByteArray): Pair<Int, List<FrameFmt>> {
        val out = ArrayList<FrameFmt>()
        var vs = -1
        var inVs = false
        var formatIdx = 0
        var kind = 0 // 1 MJPEG，2 YUY2，0 其它（不用）
        var i = 0
        fun u8(p: Int) = d[p].toInt() and 0xFF
        fun u16(p: Int) = u8(p) or (u8(p + 1) shl 8)
        fun u32(p: Int) = u16(p) or (u16(p + 2) shl 16)
        while (i + 2 <= d.size) {
            val len = u8(i)
            if (len < 2 || i + len > d.size) break
            val type = u8(i + 1)
            if (type == 4 && len >= 9) {
                inVs = u8(i + 5) == 14 && u8(i + 6) == 2
                if (inVs) vs = u8(i + 2)
            } else if (type == 0x24 && inVs && len >= 3) {
                when (u8(i + 2)) {
                    6 -> { formatIdx = u8(i + 3); kind = 1 }
                    4 -> {
                        formatIdx = u8(i + 3)
                        kind = if (String(d, i + 5, 4, Charsets.ISO_8859_1) == "YUY2") 2 else 0
                    }
                    5, 7 -> if (kind != 0 && len >= 26) {
                        val n = u8(i + 25)
                        var best = u32(i + 21)
                        // 取离 30 帧最近的：模组最高 120 帧，但人脸检测只吃得下 30 帧，多的白耗 USB 带宽和解码
                        val intervals = if (n > 0) (0 until n).map { u32(i + 26 + 4 * it) } else listOf(u32(i + 26))
                        intervals.minByOrNull { kotlin.math.abs(it - 333333) }?.let { best = it }
                        out += FrameFmt(kind == 1, formatIdx, u8(i + 3), u16(i + 5), u16(i + 7), best)
                    }
                }
            }
            i += len
        }
        return vs to out
    }

    /** 优先 MJPEG（省带宽、不用转码），分辨率离 1280x720 最近（眼动够用，再大解码吃不消），同分辨率取帧率高的 */
    private fun pick(list: List<FrameFmt>): FrameFmt? {
        val pool = list.filter { it.mjpeg }.ifEmpty { list }
        return pool.minWithOrNull(compareBy({ kotlin.math.abs(it.w * it.h - 1280 * 720) }, { it.interval }))
    }

    /** VS PROBE → COMMIT，返回协商后的单次最大载荷字节数 */
    private fun negotiate(c: UsbDeviceConnection, vs: Int, f: FrameFmt): Int {
        val SET_CUR = 0x01
        val GET_CUR = 0x81
        val PROBE = 0x0100
        val COMMIT = 0x0200
        for (size in intArrayOf(34, 26)) {
            val p = ByteArray(size)
            p[0] = 1 // bmHint：固定帧间隔
            p[2] = f.formatIndex.toByte()
            p[3] = f.frameIndex.toByte()
            for (k in 0..3) p[4 + k] = (f.interval shr (8 * k)).toByte()
            if (c.controlTransfer(0x21, SET_CUR, PROBE, vs, p, size, 1000) < 0) continue
            if (c.controlTransfer(0xA1, GET_CUR, PROBE, vs, p, size, 1000) < 0) continue
            if (c.controlTransfer(0x21, SET_CUR, COMMIT, vs, p, size, 1000) < 0) continue
            return (p[22].toInt() and 0xFF) or ((p[23].toInt() and 0xFF) shl 8) or ((p[24].toInt() and 0xFF) shl 16) or ((p[25].toInt() and 0xFF) shl 24)
        }
        throw IllegalStateException("UVC 协商失败")
    }

    /** 收等时包。struct usbdevfs_urb（64 位）：type@0 endpoint@1 status@4 flags@8 buffer@16 buffer_length@24 actual_length@28 start_frame@32 number_of_packets@36 error_count@40 signr@44 usercontext@48 iso_frame_desc@56（每个 12 字节） */
    private fun pump(c: UsbDeviceConnection, ep: UsbEndpoint, f: FrameFmt) {
        val fd = c.fileDescriptor
        val pkt = packetBytes(ep)
        val urbs = Array(URB_COUNT) {
            val m = Memory((56 + PACKETS * 12).toLong())
            val b = Memory((pkt * PACKETS).toLong())
            m.clear()
            m.setByte(0, 0) // USBDEVFS_URB_TYPE_ISO
            m.setByte(1, ep.address.toByte())
            m.setInt(8, 2) // USBDEVFS_URB_ISO_ASAP
            m.setPointer(16, b)
            m.setInt(24, pkt * PACKETS)
            m.setInt(36, PACKETS)
            m.setLong(48, it.toLong())
            for (i in 0 until PACKETS) m.setInt(56L + 12 * i, pkt)
            m to b
        }
        val submit = NativeLong(USBDEVFS_SUBMITURB)
        val reap = NativeLong(USBDEVFS_REAPURB)
        var failure: String? = null
        try {
            for ((m, _) in urbs) if (libc.ioctl(fd, submit, m) < 0) throw IllegalStateException("提交 URB 失败 errno=${Native.getLastError()}")
            val frame = ByteArrayOutputStream(512 * 1024)
            var fid = -1
            var bad = false
            val chunk = ByteArray(pkt)
            val ref = PointerByReference()
            var frames = 0L
            var t0 = System.currentTimeMillis()
            while (running) {
                if (libc.ioctl(fd, reap, ref) < 0) {
                    val e = Native.getLastError()
                    if (e == 4) continue // EINTR
                    throw IllegalStateException("收包失败 errno=$e")
                }
                val idx = ref.value.getLong(48).toInt()
                val (m, b) = urbs[idx]
                for (i in 0 until PACKETS) {
                    val off = 56L + 12 * i
                    val n = m.getInt(off + 4)
                    if (m.getInt(off + 8) != 0 || n < 2) continue
                    b.read(i.toLong() * pkt, chunk, 0, n)
                    val hl = chunk[0].toInt() and 0xFF
                    if (hl < 2 || hl > n) continue
                    val flags = chunk[1].toInt() and 0xFF
                    val thisFid = flags and 1
                    // FID 翻转 = 新的一帧，上一帧没等到 EOF 也算结束
                    if (fid != -1 && thisFid != fid && frame.size() > 0) {
                        if (!bad && publish(frame.toByteArray(), f)) frames++
                        frame.reset()
                        bad = false
                    }
                    fid = thisFid
                    if (flags and 0x40 != 0) bad = true
                    if (n > hl) frame.write(chunk, hl, n - hl)
                    if (flags and 0x02 != 0) {
                        if (!bad && frame.size() > 0 && publish(frame.toByteArray(), f)) frames++
                        frame.reset()
                        bad = false
                        // 这帧已经交了，同一 FID 后面不再重复结束
                        fid = -1
                    }
                }
                m.setInt(4, 0)
                m.setInt(28, 0)
                if (libc.ioctl(fd, submit, m) < 0) throw IllegalStateException("重新提交失败 errno=${Native.getLastError()}")
                val now = System.currentTimeMillis()
                if (now - t0 >= 5000) {
                    Log.d(TAG, "帧率 ${frames * 1000 / (now - t0)}")
                    frames = 0
                    t0 = now
                }
            }
        } catch (e: Exception) {
            failure = e.message
            Log.w(TAG, "取流中断: $failure")
        }
        // 取消没回来的 URB，并等它们回来：回来之前缓冲区不能释放
        val discard = NativeLong(USBDEVFS_DISCARDURB)
        for ((m, _) in urbs) libc.ioctl(fd, discard, m)
        val nd = NativeLong(USBDEVFS_REAPURBNDELAY)
        val ref = PointerByReference()
        val deadline = System.currentTimeMillis() + 500
        while (System.currentTimeMillis() < deadline) {
            if (libc.ioctl(fd, nd, ref) < 0 && Native.getLastError() != 11) break // 11 = EAGAIN，还有没回来的
        }
        if (failure != null) emit(JSONObject().put("t", "uvc_lost").put("error", failure))
        synchronized(urbs) { urbs.size } // 让缓冲区活到这里
    }

    private fun publish(data: ByteArray, f: FrameFmt): Boolean {
        val jpeg = if (f.mjpeg) {
            if (data.size < 4 || data[0] != 0xFF.toByte() || data[1] != 0xD8.toByte()) return false
            data
        } else {
            if (data.size < f.w * f.h * 2) return false
            val o = ByteArrayOutputStream(data.size / 8)
            YuvImage(data, ImageFormat.YUY2, f.w, f.h, null).compressToJpeg(Rect(0, 0, f.w, f.h), 85, o)
            o.toByteArray()
        }
        synchronized(lock) {
            latest = jpeg
            latestSeq++
            lock.notifyAll()
        }
        return true
    }

    /** 等比 after 新的一帧，最多等 1 秒；没有就返回 null（页面再来取） */
    fun awaitFrame(after: Long): Pair<Long, ByteArray>? {
        synchronized(lock) {
            val end = System.currentTimeMillis() + 1000
            // 重开摄像头时 latest 清空了但序号还留着，所以两个都要看
            while (latest == null || latestSeq <= after) {
                val left = end - System.currentTimeMillis()
                if (left <= 0 || !running) return null
                lock.wait(left)
            }
            return latestSeq to latest!!
        }
    }

    fun close() {
        pendingReq = null
        running = false
        // 拔掉时 ioctl 会马上返回 ENODEV；没拔时等下一包回来就能退出
        worker?.join(1500)
        worker = null
        val c = conn
        conn = null
        try {
            streamIf?.let { c?.setInterface(it) }
            c?.close()
        } catch (_: Exception) {
        }
        streamIf = null
        synchronized(lock) {
            latest = null
            lock.notifyAll()
        }
    }

    companion object {
        const val TAG = "GlintUvc"
        const val URB_COUNT = 8
        const val PACKETS = 32
        // ioctl 编号（aarch64）：_IOR('U',10,56 字节)、_IO('U',11)、_IOW('U',12,指针)、_IOW('U',13,指针)
        const val USBDEVFS_SUBMITURB = 0x8038550AL
        const val USBDEVFS_DISCARDURB = 0x550BL
        const val USBDEVFS_REAPURB = 0x4008550CL
        const val USBDEVFS_REAPURBNDELAY = 0x4008550DL
    }
}
