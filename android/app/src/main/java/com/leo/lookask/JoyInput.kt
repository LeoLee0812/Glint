package com.leo.lookask

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.input.InputManager
import android.os.BatteryManager
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.util.Log
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Joy-Con 接入：Android 不让普通 App 碰原始 HID，手柄先在系统蓝牙里配对，这里读系统的按键 / 摇杆事件，
 * 按 0x30 报告的位序拼成和桌面原生助手一样的 joy 事件，渲染进程的 input/joycon.ts 不用改。
 * 震动、电量、陀螺仪走 InputDevice（Android 12+）。HOME 灯和玩家灯系统不开放，收到命令直接忽略。
 */
class JoyInput(private val ctx: Context, private val emit: (JSONObject) -> Unit) : InputManager.InputDeviceListener {
    private class Pad(val dev: InputDevice, val side: String) {
        var mask = 0
        var lx = 0f; var ly = 0f; var rx = 0f; var ry = 0f
        var hatMask = 0
        var bat = -1
        var chg = false
        var sensors: SensorEventListener? = null
        var lastGyro = 0L
    }

    private val im = ctx.getSystemService(InputManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private val pads = HashMap<Int, Pad>()

    fun start() {
        im.registerInputDeviceListener(this, main)
        rescan()
    }

    fun stop() {
        im.unregisterInputDeviceListener(this)
    }

    private fun rescan() {
        val alive = InputDevice.getDeviceIds().toSet()
        pads.keys.filter { it !in alive }.forEach { onInputDeviceRemoved(it) }
        alive.forEach { if (it !in pads) onInputDeviceAdded(it) }
    }

    private fun sideOf(d: InputDevice): String? {
        val name = d.name ?: return null
        // hid-nintendo 给 IMU 单独建了一个输入设备，按键不走它
        if (name.contains("IMU", ignoreCase = true)) return null
        val nintendo = d.vendorId == 0x057e
        return when {
            nintendo && d.productId == 0x2006 -> "L"
            nintendo && d.productId == 0x2007 -> "R"
            nintendo && d.productId == 0x2009 -> "P"
            Regex("joy-?con.*(\\(l\\)|left)|left.*joy-?con", RegexOption.IGNORE_CASE).containsMatchIn(name) -> "L"
            Regex("joy-?con.*(\\(r\\)|right)|right.*joy-?con", RegexOption.IGNORE_CASE).containsMatchIn(name) -> "R"
            Regex("pro controller", RegexOption.IGNORE_CASE).containsMatchIn(name) -> "P"
            else -> null
        }
    }

    override fun onInputDeviceAdded(id: Int) {
        val d = InputDevice.getDevice(id) ?: return
        Log.d(TAG, "device id=$id name=${d.name} vid=${d.vendorId.toString(16)} pid=${d.productId.toString(16)} src=${d.sources.toString(16)} ranges=${d.motionRanges.map { MotionEvent.axisToString(it.axis) }}")
        val side = sideOf(d) ?: return
        val p = Pad(d, side)
        pads[id] = p
        readBattery(p)
        emitConn(p, true)
        emitState(p)
    }

    override fun onInputDeviceRemoved(id: Int) {
        val p = pads.remove(id) ?: return
        stopGyro(p)
        emitConn(p, false)
    }

    override fun onInputDeviceChanged(id: Int) {
        pads[id]?.let { p ->
            readBattery(p)
            emitState(p)
        }
    }

    private fun emitConn(p: Pad, connected: Boolean) {
        emit(
            JSONObject().put("t", "joy_conn").put("side", p.side).put("id", p.dev.descriptor)
                .put("name", when (p.side) { "L" -> "Joy-Con (L)"; "R" -> "Joy-Con (R)"; else -> "Pro Controller" })
                .put("connected", connected)
        )
    }

    private fun emitState(p: Pad) {
        emit(
            JSONObject().put("t", "joy").put("side", p.side).put("id", p.dev.descriptor).put("b", p.mask or p.hatMask)
                .put("lx", p.lx.toDouble()).put("ly", p.ly.toDouble()).put("rx", p.rx.toDouble()).put("ry", p.ry.toDouble())
                .put("bat", p.bat).put("chg", p.chg)
        )
    }

    private fun readBattery(p: Pad) {
        val b = p.dev.batteryState
        if (b.isPresent) {
            val cap = b.capacity
            // 渲染进程按 0~4 档显示
            p.bat = if (cap.isNaN()) -1 else (cap * 4).roundToInt().coerceIn(0, 4)
            p.chg = b.status == BatteryManager.BATTERY_STATUS_CHARGING
        }
    }

    // ---------- 按键 ----------

    /** 按 evdev 扫描码认键（hid-nintendo 的键位），不看 keycode：keycode 取决于系统的 .kl 映射，A/B 经常是反的 */
    private fun bitOfScan(side: String, sc: Int): Int? = when (sc) {
        304 -> 2 // B
        305 -> 3 // A
        307 -> 1 // X
        308 -> 0 // Y
        309 -> 13 // Capture
        310 -> when (side) { "R" -> 5; else -> 22 } // 右手柄的 BTN_TL 是侧键 SL；左手柄 / Pro 是 L
        311 -> when (side) { "L" -> 20; else -> 6 } // 左手柄的 BTN_TR 是侧键 SR；右手柄 / Pro 是 R
        312 -> when (side) { "R" -> 4; else -> 23 } // 右手柄的 BTN_TL2 是侧键 SR；左手柄 / Pro 是 ZL
        313 -> when (side) { "L" -> 21; else -> 7 } // 左手柄的 BTN_TR2 是侧键 SL；右手柄 / Pro 是 ZR
        314 -> 8 // −
        315 -> 9 // +
        316 -> 12 // Home
        317 -> 11 // 左摇杆按下
        318 -> 10 // 右摇杆按下
        544 -> 17 // 上
        545 -> 16 // 下
        546 -> 19 // 左
        547 -> 18 // 右
        else -> null
    }

    /** 扫描码认不出（不是 hid-nintendo）时才看 keycode */
    private fun bitOfKey(kc: Int): Int? = when (kc) {
        KeyEvent.KEYCODE_BUTTON_A -> 3
        KeyEvent.KEYCODE_BUTTON_B -> 2
        KeyEvent.KEYCODE_BUTTON_X -> 1
        KeyEvent.KEYCODE_BUTTON_Y -> 0
        KeyEvent.KEYCODE_BUTTON_L1 -> 22
        KeyEvent.KEYCODE_BUTTON_L2 -> 23
        KeyEvent.KEYCODE_BUTTON_R1 -> 6
        KeyEvent.KEYCODE_BUTTON_R2 -> 7
        KeyEvent.KEYCODE_BUTTON_SELECT -> 8
        KeyEvent.KEYCODE_BUTTON_START -> 9
        KeyEvent.KEYCODE_BUTTON_MODE -> 12
        KeyEvent.KEYCODE_BUTTON_THUMBL -> 11
        KeyEvent.KEYCODE_BUTTON_THUMBR -> 10
        KeyEvent.KEYCODE_DPAD_UP -> 17
        KeyEvent.KEYCODE_DPAD_DOWN -> 16
        KeyEvent.KEYCODE_DPAD_LEFT -> 19
        KeyEvent.KEYCODE_DPAD_RIGHT -> 18
        else -> null
    }

    /** 返回 true = 手柄的键，不再往 WebView 传（否则 A 键会被当成点击、方向键会滚动页面） */
    fun onKey(ev: KeyEvent): Boolean {
        val p = pads[ev.deviceId] ?: return false
        if (ev.action != KeyEvent.ACTION_DOWN && ev.action != KeyEvent.ACTION_UP) return true
        if (ev.repeatCount > 0) return true
        val bit = bitOfScan(p.side, ev.scanCode) ?: bitOfKey(ev.keyCode)
        Log.d(TAG, "key ${p.side} sc=${ev.scanCode} kc=${KeyEvent.keyCodeToString(ev.keyCode)} act=${ev.action} bit=$bit")
        if (bit == null) return true
        val m = 1 shl bit
        p.mask = if (ev.action == KeyEvent.ACTION_DOWN) p.mask or m else p.mask and m.inv()
        emitState(p)
        return true
    }

    private fun stick(x: Float, y: Float): Pair<Float, Float> {
        val mag = hypot(x, y)
        if (mag < DEADZONE) return 0f to 0f
        val s = min(1f, (mag - DEADZONE) / (1 - DEADZONE)) / mag
        // Android 的 y 向下为正，渲染进程约定向上为正
        return (x * s) to (-y * s)
    }

    fun onMotion(ev: MotionEvent): Boolean {
        val p = pads[ev.deviceId] ?: return false
        if (ev.action != MotionEvent.ACTION_MOVE) return true
        val d = p.dev
        val has = { axis: Int -> d.getMotionRange(axis, ev.source) != null }
        val a = { axis: Int -> ev.getAxisValue(axis) }
        val before = listOf(p.lx, p.ly, p.rx, p.ry, p.hatMask)
        if (p.side != "R") {
            val (x, y) = stick(a(MotionEvent.AXIS_X), a(MotionEvent.AXIS_Y))
            p.lx = x; p.ly = y
        }
        if (p.side != "L") {
            // 右摇杆：hid-nintendo 报 ABS_RX/RY；系统映射可能叫 Z/RZ；单只右手柄也可能就走 X/Y
            val (sx, sy) = when {
                has(MotionEvent.AXIS_RX) -> a(MotionEvent.AXIS_RX) to a(MotionEvent.AXIS_RY)
                has(MotionEvent.AXIS_Z) -> a(MotionEvent.AXIS_Z) to a(MotionEvent.AXIS_RZ)
                else -> a(MotionEvent.AXIS_X) to a(MotionEvent.AXIS_Y)
            }
            val (x, y) = stick(sx, sy)
            p.rx = x; p.ry = y
        }
        // 十字键不是按键而是 HAT 轴的情况
        var hat = 0
        val hx = a(MotionEvent.AXIS_HAT_X)
        val hy = a(MotionEvent.AXIS_HAT_Y)
        if (hy < -0.5f) hat = hat or (1 shl 17)
        if (hy > 0.5f) hat = hat or (1 shl 16)
        if (hx < -0.5f) hat = hat or (1 shl 19)
        if (hx > 0.5f) hat = hat or (1 shl 18)
        p.hatMask = hat
        if (before != listOf(p.lx, p.ly, p.rx, p.ry, p.hatMask)) emitState(p)
        return true
    }

    // ---------- 渲染进程发来的命令 ----------

    fun command(c: JSONObject) {
        main.post {
            when (c.optString("cmd")) {
                "joy_list" -> {
                    rescan()
                    pads.values.forEach { emitConn(it, true); emitState(it) }
                }
                "rumble" -> vibrate(c.optString("side"), longArrayOf(c.optLong("ms", 70)), intArrayOf(amp(c.optDouble("amp", 0.45))))
                "rumble_seq" -> c.optJSONArray("seq")?.let { playSeq(c.optString("side"), it) }
                "joy_find" -> vibrate("", longArrayOf(c.optLong("seconds", 3) * 1000), intArrayOf(255))
                "imu_stream" -> imuStream(c.optString("side"), c.optBoolean("on"))
                // HOME 灯、玩家灯：系统不开放
            }
        }
    }

    private fun amp(v: Double) = (v.coerceIn(0.0, 1.0) * 255).roundToInt()

    /** 分段震动：系统只能调强度和时长，频率丢掉，渐变取两端平均 */
    private fun playSeq(side: String, seq: JSONArray) {
        val times = LongArray(seq.length())
        val amps = IntArray(seq.length())
        for (i in 0 until seq.length()) {
            val s = seq.getJSONArray(i)
            times[i] = max(1L, s.optLong(0))
            val a0 = s.optDouble(3, 0.0)
            val a1 = s.optDouble(6, a0)
            amps[i] = amp((a0 + a1) / 2)
        }
        vibrate(side, times, amps)
    }

    private fun vibrate(side: String, times: LongArray, amps: IntArray) {
        pads.values.filter { side.isEmpty() || it.side == side || it.side == "P" }.forEach { p ->
            try {
                val vm = p.dev.vibratorManager
                if (vm.vibratorIds.isEmpty()) return@forEach
                val effect = if (times.size == 1) {
                    VibrationEffect.createOneShot(times[0], max(1, amps[0]))
                } else {
                    VibrationEffect.createWaveform(times, amps, -1)
                }
                vm.defaultVibrator.vibrate(effect)
            } catch (e: Exception) {
                Log.w(TAG, "震动失败 ${e.message}")
            }
        }
    }

    // ---------- 手腕精调：陀螺仪 ----------

    private fun imuStream(side: String, on: Boolean) {
        pads.values.filter { it.side == side || it.side == "P" }.forEach { p ->
            stopGyro(p)
            if (!on) return@forEach
            val sm = p.dev.sensorManager
            val gyro = sm.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
            if (gyro == null) {
                Log.d(TAG, "${p.side} 没有陀螺仪接口")
                return@forEach
            }
            val l = object : SensorEventListener {
                override fun onSensorChanged(e: SensorEvent) {
                    val dt = if (p.lastGyro == 0L) 0f else (e.timestamp - p.lastGyro) / 1e9f
                    p.lastGyro = e.timestamp
                    if (dt <= 0f || dt > 0.2f) return
                    val deg = 57.29578f * dt
                    emit(
                        JSONObject().put("t", "joy_gyro").put("side", p.side).put("id", p.dev.descriptor)
                            .put("yaw", (-e.values[2] * deg).toDouble()).put("pitch", (e.values[1] * deg).toDouble())
                    )
                }

                override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
            }
            sm.registerListener(l, gyro, SensorManagerRate, main)
            p.sensors = l
            p.lastGyro = 0
            // 和桌面版一样：最多 20 秒，渲染进程忘了关也会自己停
            main.postDelayed({ if (p.sensors === l) stopGyro(p) }, 20_000)
        }
    }

    private fun stopGyro(p: Pad) {
        p.sensors?.let { p.dev.sensorManager.unregisterListener(it) }
        p.sensors = null
    }

    companion object {
        const val TAG = "GlintJoy"
        const val DEADZONE = 0.14f
        const val SensorManagerRate = 15_000
    }
}
