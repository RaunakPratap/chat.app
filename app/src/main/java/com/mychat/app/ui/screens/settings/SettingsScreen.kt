package com.mychat.app.ui.screens.settings

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mychat.app.model.User
import com.mychat.app.model.UserSettings
import com.mychat.app.ui.components.UserAvatar
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    myUser: User?,
    settings: UserSettings,
    screenshotBlockEnabled: Boolean,
    onToggleScreenshotBlock: (Boolean) -> Unit,
    onUpdateSetting: (key: String, value: Any) -> Unit,
    onUploadDp: (ByteArray, String) -> Unit,
    onBack: () -> Unit,
    onLogout: () -> Unit,
    shakeToDeleteEnabled: Boolean = true,
    shakeDeleteMode: String = "current",
    shakeSensitivity: String = "medium",
    onUpdateShakeSettings: (enabled: Boolean, mode: String, sensitivity: String) -> Unit = { _, _, _ -> }
) {
    val accent = Color(0xFF0B8C72)
    var showLogoutConfirm by remember { mutableStateOf(false) }
    val context = LocalContext.current
    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    val imagePickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.GetContent()
    ) { uri: Uri? ->
        if (uri != null) {
            try {
                val inputStream = context.contentResolver.openInputStream(uri)
                val bytes = inputStream?.readBytes()
                inputStream?.close()
                if (bytes != null && bytes.isNotEmpty()) {
                    onUploadDp(bytes, "profile_${System.currentTimeMillis()}.jpg")
                }
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }

    if (showLogoutConfirm) {
        AlertDialog(
            onDismissRequest = { showLogoutConfirm = false },
            title = { Text("Log Out", fontWeight = FontWeight.Bold) },
            text = { Text("Are you sure you want to log out of MyChat?") },
            confirmButton = {
                Button(
                    onClick = {
                        showLogoutConfirm = false
                        onLogout()
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
                    shape = RoundedCornerShape(12.dp)
                ) {
                    Text("Log Out")
                }
            },
            dismissButton = {
                TextButton(onClick = { showLogoutConfirm = false }) { Text("Cancel") }
            },
            shape = RoundedCornerShape(22.dp)
        )
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = {
            Column(Modifier.background(MaterialTheme.colorScheme.surface)) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(72.dp)
                        .padding(horizontal = 8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                    Column(Modifier.weight(1f)) {
                        Text("Settings", fontWeight = FontWeight(850), fontSize = 20.sp)
                        Text("Preferences & Security", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            }
        }
    ) { padding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .background(MaterialTheme.colorScheme.background)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {

            // ── PROFILE ──────────────────────────────────────────────────────
            item {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(20.dp))
                        .background(MaterialTheme.colorScheme.surface)
                        .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(20.dp))
                        .padding(16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(14.dp)
                ) {
                    Box(modifier = Modifier.clickable { imagePickerLauncher.launch("image/*") }) {
                        UserAvatar(name = myUser?.displayName ?: "User", dp = myUser?.dp, size = 64.dp)
                        Box(
                            modifier = Modifier
                                .size(24.dp)
                                .clip(CircleShape)
                                .background(accent)
                                .align(Alignment.BottomEnd),
                            contentAlignment = Alignment.Center
                        ) {
                            Icon(Icons.Default.CameraAlt, contentDescription = "Change DP", tint = Color.White, modifier = Modifier.size(14.dp))
                        }
                    }
                    Column(Modifier.weight(1f)) {
                        Text(myUser?.displayName ?: "MyChat User", fontWeight = FontWeight.Bold, fontSize = 16.sp)
                        Text(myUser?.phone ?: "", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Spacer(Modifier.height(4.dp))
                        Text(
                            text = "Tap photo to change DP",
                            fontSize = 11.sp,
                            color = accent,
                            fontWeight = FontWeight.SemiBold
                        )
                    }
                }
            }

            // ── APPEARANCE ───────────────────────────────────────────────────
            item { SectionHeader("APPEARANCE") }

            item {
                SettingCard {
                    // App Theme
                    SettingOptionItem(
                        icon = Icons.Default.Palette,
                        title = "App Theme",
                        currentValue = settings.theme.replaceFirstChar { it.uppercase() },
                        onClick = {
                            val next = when (settings.theme) {
                                "light" -> "dark"
                                "dark" -> "system"
                                else -> "light"
                            }
                            onUpdateSetting("theme", next)
                        }
                    )
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                    // Chat Wallpaper
                    SettingOptionItem(
                        icon = Icons.Default.Wallpaper,
                        title = "Chat Wallpaper",
                        currentValue = settings.wallpaper.replaceFirstChar { it.uppercase() },
                        onClick = {
                            val next = when (settings.wallpaper) {
                                "classic" -> "minimal"
                                "minimal" -> "dark"
                                "dark" -> "nature"
                                else -> "classic"
                            }
                            onUpdateSetting("wallpaper", next)
                        }
                    )
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                    // Message Density
                    SettingOptionItem(
                        icon = Icons.Default.FormatLineSpacing,
                        title = "Message Density",
                        currentValue = settings.messageDensity.replaceFirstChar { it.uppercase() },
                        onClick = {
                            val next = when (settings.messageDensity) {
                                "comfortable" -> "compact"
                                "compact" -> "cozy"
                                else -> "comfortable"
                            }
                            onUpdateSetting("message_density", next)
                        }
                    )
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                    // Compact Bubbles
                    SettingSwitchItem(
                        icon = Icons.Default.ChatBubbleOutline,
                        title = "Compact Bubbles",
                        subtitle = "Reduce padding inside message bubbles",
                        checked = settings.compactBubbles,
                        onCheckedChange = { onUpdateSetting("compact_bubbles", it) }
                    )
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                    // Bubble Animations
                    SettingSwitchItem(
                        icon = Icons.Default.Animation,
                        title = "Bubble Animations",
                        subtitle = "Smooth UI transitions and bubble animations",
                        checked = settings.animations,
                        onCheckedChange = { onUpdateSetting("animations", it) }
                    )
                }
            }

            // ── SECURITY & PRIVACY ───────────────────────────────────────────
            item { SectionHeader("SECURITY & PRIVACY") }

            item {
                SettingCard {
                    SettingSwitchItem(
                        icon = Icons.Default.Security,
                        title = "Block Screenshots & Screen Recording",
                        subtitle = "Prevents screenshots, screen recording, and app switcher preview",
                        checked = screenshotBlockEnabled,
                        onCheckedChange = onToggleScreenshotBlock
                    )
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                    SettingSwitchItem(
                        icon = Icons.Default.DoneAll,
                        title = "Read Receipts",
                        subtitle = "Show blue checkmarks when messages are read",
                        checked = settings.readReceipts,
                        onCheckedChange = { onUpdateSetting("read_receipts", it) }
                    )
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                    SettingSwitchItem(
                        icon = Icons.Default.Edit,
                        title = "Typing Indicator",
                        subtitle = "Show when you are typing a message",
                        checked = settings.typingIndicator,
                        onCheckedChange = { onUpdateSetting("typing_indicator", it) }
                    )
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                    SettingOptionItem(
                        icon = Icons.Default.AccessTime,
                        title = "Last Seen Visibility",
                        currentValue = settings.lastSeenVisibility.replaceFirstChar { it.uppercase() },
                        onClick = {
                            val next = when (settings.lastSeenVisibility) {
                                "everyone" -> "nobody"
                                else -> "everyone"
                            }
                            onUpdateSetting("last_seen_visibility", next)
                        }
                    )
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                    SettingOptionItem(
                        icon = Icons.Default.WifiFind,
                        title = "Online Visibility",
                        currentValue = settings.onlineVisibility.replaceFirstChar { it.uppercase() },
                        onClick = {
                            val next = when (settings.onlineVisibility) {
                                "everyone" -> "nobody"
                                else -> "everyone"
                            }
                            onUpdateSetting("online_visibility", next)
                        }
                    )
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                    SettingOptionItem(
                        icon = Icons.Default.Person,
                        title = "Profile Photo Visibility",
                        currentValue = settings.dpVisibility.replaceFirstChar { it.uppercase() },
                        onClick = {
                            val next = when (settings.dpVisibility) {
                                "everyone" -> "nobody"
                                else -> "everyone"
                            }
                            onUpdateSetting("dp_visibility", next)
                        }
                    )
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                    SettingOptionItem(
                        icon = Icons.Default.Circle,
                        title = "Status Visibility",
                        currentValue = settings.statusVisibility.replaceFirstChar { it.uppercase() },
                        onClick = {
                            val next = when (settings.statusVisibility) {
                                "everyone" -> "contacts"
                                "contacts" -> "nobody"
                                else -> "everyone"
                            }
                            onUpdateSetting("status_visibility", next)
                        }
                    )
                }
            }

            // ── ANTI-SNATCH & EMERGENCY WIPE ─────────────────────────────────
            item { SectionHeader("🛡️ ANTI-SNATCH & EMERGENCY WIPE (SHAKE)") }

            item {
                SettingCard {
                    SettingSwitchItem(
                        icon = Icons.Default.Vibration,
                        title = "Shake to Delete Chat",
                        subtitle = "Phone chheenne par ya emergency mein hilte hi chat turant delete ho jayegi",
                        checked = shakeToDeleteEnabled,
                        onCheckedChange = { isEnabled ->
                            onUpdateShakeSettings(isEnabled, shakeDeleteMode, shakeSensitivity)
                            scope.launch {
                                snackbarHostState.showSnackbar(
                                    if (isEnabled) "Emergency Shake to Delete activated!"
                                    else "Shake to Delete disabled."
                                )
                            }
                        }
                    )
                    if (shakeToDeleteEnabled) {
                        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                        SettingOptionItem(
                            icon = Icons.Default.DeleteSweep,
                            title = "Wipe Target",
                            currentValue = when (shakeDeleteMode) {
                                "current" -> "Current Open Chat"
                                "selected" -> "Emergency Contacts"
                                else -> "All Chats (Panic Wipe)"
                            },
                            onClick = {
                                val next = when (shakeDeleteMode) {
                                    "current" -> "all"
                                    "all" -> "selected"
                                    else -> "current"
                                }
                                onUpdateShakeSettings(shakeToDeleteEnabled, next, shakeSensitivity)
                            }
                        )
                        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                        SettingOptionItem(
                            icon = Icons.Default.Speed,
                            title = "Shake Sensitivity",
                            currentValue = when (shakeSensitivity) {
                                "high" -> "High (Quick Snatch / Fast Jerk)"
                                "low" -> "Low (Firm Shake Only)"
                                else -> "Medium (Recommended)"
                            },
                            onClick = {
                                val next = when (shakeSensitivity) {
                                    "medium" -> "high"
                                    "high" -> "low"
                                    else -> "medium"
                                }
                                onUpdateShakeSettings(shakeToDeleteEnabled, shakeDeleteMode, next)
                            }
                        )
                    }
                }
            }

            // ── NOTIFICATIONS ────────────────────────────────────────────────
            item { SectionHeader("NOTIFICATIONS") }

            item {
                SettingCard {
                    SettingSwitchItem(
                        icon = Icons.Default.Notifications,
                        title = "Push Notifications",
                        subtitle = "Receive notifications for new messages",
                        checked = settings.notifications,
                        onCheckedChange = { onUpdateSetting("notifications", it) }
                    )
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                    SettingSwitchItem(
                        icon = Icons.Default.Preview,
                        title = "Notification Previews",
                        subtitle = "Show message text in notification banner",
                        checked = settings.notificationPreview,
                        onCheckedChange = { onUpdateSetting("notification_preview", it) }
                    )
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                    SettingSwitchItem(
                        icon = Icons.Default.Vibration,
                        title = "Vibrate on Message",
                        subtitle = "Vibrate device when new message arrives",
                        checked = settings.notificationVibrate,
                        onCheckedChange = { onUpdateSetting("notification_vibrate", it) }
                    )
                }
            }

            // ── CHAT EXPERIENCE ──────────────────────────────────────────────
            item { SectionHeader("CHAT EXPERIENCE") }

            item {
                SettingCard {
                    SettingSwitchItem(
                        icon = Icons.AutoMirrored.Filled.Send,
                        title = "Enter to Send",
                        subtitle = "Pressing enter key sends the message",
                        checked = settings.enterToSend,
                        onCheckedChange = { onUpdateSetting("enter_to_send", it) }
                    )
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                    SettingSwitchItem(
                        icon = Icons.Default.AutoAwesome,
                        title = "Glass UI Effect",
                        subtitle = "Apply frosted glass effect to chat surfaces",
                        checked = settings.glassUi,
                        onCheckedChange = { onUpdateSetting("glass_ui", it) }
                    )
                }
            }

            // ── STORAGE & DATA ───────────────────────────────────────────────
            item { SectionHeader("STORAGE & DATA") }

            item {
                SettingCard {
                    SettingInfoItem(
                        icon = Icons.Default.PhoneAndroid,
                        title = "Auto-download",
                        subtitle = "Media auto-downloads on WiFi"
                    )
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                    SettingClickItem(
                        icon = Icons.Default.Delete,
                        title = "Clear Cache",
                        subtitle = "Free up storage used by cached media",
                        onClick = {
                            scope.launch {
                                snackbarHostState.showSnackbar("Cache cleared!")
                            }
                        }
                    )
                }
            }

            // ── ABOUT ────────────────────────────────────────────────────────
            item { SectionHeader("ABOUT") }

            item {
                SettingCard {
                    SettingInfoItem(
                        icon = Icons.Default.Info,
                        title = "App Version",
                        subtitle = "v1.0.0"
                    )
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                    SettingClickItem(
                        icon = Icons.Default.HelpOutline,
                        title = "Help & Support",
                        subtitle = "Get help with MyChat",
                        onClick = {
                            scope.launch {
                                snackbarHostState.showSnackbar("Help coming soon")
                            }
                        }
                    )
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                    SettingClickItem(
                        icon = Icons.Default.PrivacyTip,
                        title = "Privacy Policy",
                        subtitle = "Read our privacy policy",
                        onClick = {
                            scope.launch {
                                snackbarHostState.showSnackbar("Privacy Policy coming soon")
                            }
                        }
                    )
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                    SettingClickItem(
                        icon = Icons.Default.Article,
                        title = "Terms of Service",
                        subtitle = "Read our terms of service",
                        onClick = {
                            scope.launch {
                                snackbarHostState.showSnackbar("Terms coming soon")
                            }
                        }
                    )
                }
            }

            // ── ACCOUNT ──────────────────────────────────────────────────────
            item { SectionHeader("ACCOUNT") }

            item {
                Button(
                    onClick = { showLogoutConfirm = true },
                    shape = RoundedCornerShape(16.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error.copy(alpha = 0.12f)),
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(52.dp)
                ) {
                    Icon(Icons.AutoMirrored.Filled.Logout, null, tint = MaterialTheme.colorScheme.error)
                    Spacer(Modifier.width(8.dp))
                    Text("Log Out of MyChat", color = MaterialTheme.colorScheme.error, fontWeight = FontWeight.Bold)
                }
            }

            item {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .padding(top = 10.dp, bottom = 20.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        "MyChat Native Android App · v1.0.0",
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f)
                    )
                }
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Private composables
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun SectionHeader(title: String) {
    Text(
        title,
        fontSize = 11.sp,
        fontWeight = FontWeight.ExtraBold,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 6.dp, bottom = 2.dp)
    )
}

@Composable
private fun SettingCard(content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .background(MaterialTheme.colorScheme.surface)
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(18.dp))
            .padding(vertical = 4.dp),
        content = content
    )
}

@Composable
private fun SettingSwitchItem(
    icon: ImageVector,
    title: String,
    subtitle: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit
) {
    val accent = Color(0xFF0B8C72)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onCheckedChange(!checked) }
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Box(
            Modifier
                .size(38.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(accent.copy(alpha = 0.12f)),
            contentAlignment = Alignment.Center
        ) {
            Icon(icon, null, tint = accent, modifier = Modifier.size(20.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(title, fontWeight = FontWeight.Bold, fontSize = 13.5.sp)
            Text(subtitle, fontSize = 11.5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Switch(
            checked = checked,
            onCheckedChange = onCheckedChange,
            colors = SwitchDefaults.colors(
                checkedThumbColor = Color.White,
                checkedTrackColor = accent
            )
        )
    }
}

@Composable
private fun SettingOptionItem(
    icon: ImageVector,
    title: String,
    currentValue: String,
    onClick: () -> Unit
) {
    val accent = Color(0xFF0B8C72)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Box(
            Modifier
                .size(38.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(accent.copy(alpha = 0.12f)),
            contentAlignment = Alignment.Center
        ) {
            Icon(icon, null, tint = accent, modifier = Modifier.size(20.dp))
        }
        Text(title, fontWeight = FontWeight.Bold, fontSize = 13.5.sp, modifier = Modifier.weight(1f))
        Text(currentValue, fontSize = 12.sp, color = accent, fontWeight = FontWeight.SemiBold)
        Icon(Icons.Default.ChevronRight, null, tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f))
    }
}

@Composable
private fun SettingInfoItem(
    icon: ImageVector,
    title: String,
    subtitle: String
) {
    val accent = Color(0xFF0B8C72)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Box(
            Modifier
                .size(38.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(accent.copy(alpha = 0.12f)),
            contentAlignment = Alignment.Center
        ) {
            Icon(icon, null, tint = accent, modifier = Modifier.size(20.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(title, fontWeight = FontWeight.Bold, fontSize = 13.5.sp)
            Text(subtitle, fontSize = 11.5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun SettingClickItem(
    icon: ImageVector,
    title: String,
    subtitle: String,
    onClick: () -> Unit
) {
    val accent = Color(0xFF0B8C72)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Box(
            Modifier
                .size(38.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(accent.copy(alpha = 0.12f)),
            contentAlignment = Alignment.Center
        ) {
            Icon(icon, null, tint = accent, modifier = Modifier.size(20.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(title, fontWeight = FontWeight.Bold, fontSize = 13.5.sp)
            Text(subtitle, fontSize = 11.5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Icon(Icons.Default.ChevronRight, null, tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f))
    }
}
