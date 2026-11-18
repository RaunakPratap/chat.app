package com.mychat.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val DarkColorScheme = darkColorScheme(
    primary = Color(0xFF14B896),
    secondary = Color(0xFF0B8C72),
    tertiary = Color(0xFF175F51),
    background = Color(0xFF0B151A),
    surface = Color(0xFF152229),
    surfaceVariant = Color(0xFF1D2C34),
    onPrimary = Color.White,
    onSecondary = Color.White,
    onBackground = Color(0xFFEAF3F5),
    onSurface = Color(0xFFEAF3F5),
    onSurfaceVariant = Color(0xFF98ABB5)
)

private val LightColorScheme = lightColorScheme(
    primary = Color(0xFF0B8C72),
    secondary = Color(0xFF14B896),
    tertiary = Color(0xFFD9FFF2),
    background = Color(0xFFEEF3F5),
    surface = Color.White,
    surfaceVariant = Color(0xFFF4F8FA),
    onPrimary = Color.White,
    onSecondary = Color.White,
    onBackground = Color(0xFF17242B),
    onSurface = Color(0xFF17242B),
    onSurfaceVariant = Color(0xFF667781)
)

@Composable
fun MyChatTheme(
    themeOverride: String? = null, // "light", "dark", "system", null
    content: @Composable () -> Unit
) {
    val systemDark = isSystemInDarkTheme()
    val darkTheme = when (themeOverride) {
        "dark" -> true
        "light" -> false
        else -> systemDark // "system" or null
    }
    val colorScheme = if (darkTheme) DarkColorScheme else LightColorScheme

    MaterialTheme(
        colorScheme = colorScheme,
        content = content
    )
}
