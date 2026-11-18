package com.mychat.app.util

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import kotlin.math.sqrt

/**
 * ShakeDetector detects quick snatch, sudden jerk, or deliberate shake
 * to trigger the Emergency Panic Wipe / Shake-to-Delete feature.
 */
class ShakeDetector(
    private val context: Context,
    private val onShakeTriggered: () -> Unit
) : SensorEventListener {

    private val sensorManager = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
    private val accelerometer = sensorManager?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)

    private var lastShakeTimestamp: Long = 0L
    private var isRunning = false

    // Threshold acceleration in m/s^2 (excluding earth's 9.8 gravity)
    var threshold: Float = 16.5f

    fun setSensitivity(level: String) {
        threshold = when (level.lowercase()) {
            "high" -> 12.0f   // Triggers easily on quick snatch/shake
            "low" -> 22.0f    // Requires firm violent shake
            else -> 16.5f     // Medium: balanced against accidental walks
        }
    }

    fun start() {
        if (!isRunning && accelerometer != null && sensorManager != null) {
            sensorManager.registerListener(this, accelerometer, SensorManager.SENSOR_DELAY_UI)
            isRunning = true
        }
    }

    fun stop() {
        if (isRunning && sensorManager != null) {
            sensorManager.unregisterListener(this)
            isRunning = false
        }
    }

    override fun onSensorChanged(event: SensorEvent?) {
        if (event == null || event.sensor.type != Sensor.TYPE_ACCELEROMETER) return

        val x = event.values[0]
        val y = event.values[1]
        val z = event.values[2]

        // Calculate total acceleration magnitude minus gravity
        val gX = x / SensorManager.GRAVITY_EARTH
        val gY = y / SensorManager.GRAVITY_EARTH
        val gZ = z / SensorManager.GRAVITY_EARTH

        val gForce = sqrt(gX * gX + gY * gY + gZ * gZ)

        // If net acceleration exceeds threshold
        if (gForce > (threshold / SensorManager.GRAVITY_EARTH)) {
            val now = System.currentTimeMillis()
            // 1.2s cooldown between shake triggers
            if (now - lastShakeTimestamp >= 1200L) {
                lastShakeTimestamp = now
                vibrateConfirmation()
                onShakeTriggered()
            }
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

    private fun vibrateConfirmation() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val vibratorManager = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
                vibratorManager?.defaultVibrator?.vibrate(
                    VibrationEffect.createWaveform(longArrayOf(0, 120, 80, 120), -1)
                )
            } else {
                @Suppress("DEPRECATION")
                val vibrator = context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    vibrator?.vibrate(
                        VibrationEffect.createWaveform(longArrayOf(0, 120, 80, 120), -1)
                    )
                } else {
                    @Suppress("DEPRECATION")
                    vibrator?.vibrate(250)
                }
            }
        } catch (_: Exception) {}
    }
}
