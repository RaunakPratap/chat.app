package com.mychat.app.ui.screens.status

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.mychat.app.model.StatusItem
import com.mychat.app.model.User
import com.mychat.app.ui.components.UserAvatar
import java.text.SimpleDateFormat
import java.util.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun StatusScreen(
    myUser: User?,
    statuses: List<StatusItem>,
    onBack: () -> Unit,
    onPostStatus: (String) -> Unit,
    onRefresh: () -> Unit,
    onLikeStatus: (statusId: Long) -> Unit = {}
) {
    val accent = Color(0xFF0B8C72)
    val accent2 = Color(0xFF14B896)

    var showCompose by remember { mutableStateOf(false) }
    var statusText by remember { mutableStateOf("") }
    var viewingStatus by remember { mutableStateOf<StatusItem?>(null) }

    val myId = myUser?.id?.toLongOrNull() ?: 0L
    val myStatuses = statuses.filter { it.userId == myId }
    val othersStatuses = statuses.filter { it.userId != myId }

    // Group others by user
    val groupedOthers = othersStatuses.groupBy { it.userId }

    if (showCompose) {
        StatusComposeDialog(
            onDismiss = { showCompose = false },
            onPost = { text ->
                onPostStatus(text)
                showCompose = false
                statusText = ""
            }
        )
    }

    // Status view dialog
    viewingStatus?.let { status ->
        StatusViewDialog(
            status = status,
            onDismiss = { viewingStatus = null },
            onLike = {
                onLikeStatus(status.id)
                viewingStatus = null
            }
        )
    }

    Scaffold(
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
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back")
                    }
                    Column(Modifier.weight(1f)) {
                        Text("Status", fontWeight = FontWeight(850), fontSize = 20.sp)
                        Text("Updates expire in 24 hours", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    IconButton(onClick = onRefresh) {
                        Icon(Icons.Default.Refresh, "Refresh")
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
        ) {
            // My status composer card
            item {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(14.dp)
                        .clip(RoundedCornerShape(16.dp))
                        .background(MaterialTheme.colorScheme.surface)
                        .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(16.dp))
                        .clickable { showCompose = true }
                        .padding(13.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    Box {
                        UserAvatar(name = myUser?.displayName ?: "U", dp = myUser?.dp, size = 48.dp)
                        // Plus button
                        Box(
                            modifier = Modifier
                                .size(20.dp)
                                .clip(CircleShape)
                                .background(Brush.linearGradient(listOf(accent2, accent)))
                                .align(Alignment.BottomEnd),
                            contentAlignment = Alignment.Center
                        ) {
                            Icon(Icons.Default.Add, null, Modifier.size(13.dp), tint = Color.White)
                        }
                    }
                    Column(Modifier.weight(1f)) {
                        Text("My Status", fontWeight = FontWeight.Bold, fontSize = 14.sp)
                        Text(
                            if (myStatuses.isEmpty()) "Tap to add status update"
                            else "${myStatuses.size} update${if (myStatuses.size > 1) "s" else ""}",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    Icon(Icons.Default.Edit, null, tint = accent)
                }
            }

            // My status chips — small clickable previews below the composer card
            if (myStatuses.isNotEmpty()) {
                item {
                    LazyRow(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 14.dp)
                            .padding(bottom = 10.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        items(myStatuses.sortedByDescending { it.createdAt }) { s ->
                            SuggestionChip(
                                onClick = { viewingStatus = s },
                                label = {
                                    Column(modifier = Modifier.padding(vertical = 4.dp)) {
                                        Text(
                                            s.body.take(30).ifBlank { "📷 Media" },
                                            fontSize = 11.sp,
                                            fontWeight = FontWeight.Medium,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis
                                        )
                                        Text(
                                            statusRelative(s.createdAt),
                                            fontSize = 10.sp,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant
                                        )
                                    }
                                },
                                shape = RoundedCornerShape(12.dp)
                            )
                        }
                    }
                }
            }

            // Others' statuses
            if (groupedOthers.isNotEmpty()) {
                item {
                    Text(
                        "RECENT UPDATES",
                        fontSize = 11.sp,
                        fontWeight = FontWeight.ExtraBold,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 18.dp, vertical = 4.dp)
                    )
                }
                items(groupedOthers.entries.toList(), key = { it.key }) { (_, userStatuses) ->
                    val latest = userStatuses.maxByOrNull { it.createdAt } ?: return@items
                    val hasUnviewed = userStatuses.any { it.hasUnviewed }
                    StatusRow(
                        status = latest,
                        hasUnviewed = hasUnviewed,
                        onClick = { viewingStatus = latest }
                    )
                }
            }

            if (statuses.isEmpty()) {
                item {
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .padding(48.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            Text("🟢", fontSize = 56.sp)
                            Text("No status updates", fontWeight = FontWeight.Bold, fontSize = 18.sp)
                            Text("Be the first to share a status update!", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Button(
                                onClick = { showCompose = true },
                                shape = RoundedCornerShape(13.dp),
                                colors = ButtonDefaults.buttonColors(containerColor = accent)
                            ) {
                                Icon(Icons.Default.Add, null, Modifier.size(16.dp))
                                Spacer(Modifier.width(6.dp))
                                Text("Add Status")
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun StatusRow(status: StatusItem, hasUnviewed: Boolean, onClick: () -> Unit = {}) {
    val ringColor = if (hasUnviewed) Color(0xFF22C55E) else Color(0xFF98ABB5)

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 6.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(MaterialTheme.colorScheme.surface)
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(16.dp))
            .clickable { onClick() }
            .padding(13.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Box(
            Modifier
                .size(56.dp)
                .clip(CircleShape)
                .border(2.5.dp, ringColor, CircleShape),
            contentAlignment = Alignment.Center
        ) {
            UserAvatar(
                name = status.name ?: "U",
                dp = status.dp,
                size = 48.dp
            )
        }
        Column(Modifier.weight(1f)) {
            Text(status.name ?: "User", fontWeight = FontWeight.Bold, fontSize = 14.sp)
            Text(
                status.body.ifBlank { "📷 Media update" }.take(60),
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        Column(horizontalAlignment = Alignment.End) {
            Text(statusRelative(status.createdAt), fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (hasUnviewed) {
                Box(
                    Modifier
                        .size(10.dp)
                        .clip(CircleShape)
                        .background(Color(0xFF22C55E))
                )
            }
        }
    }
}

@Composable
fun StatusViewDialog(
    status: StatusItem,
    onDismiss: () -> Unit,
    onLike: () -> Unit
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                UserAvatar(name = status.name ?: "U", dp = status.dp, size = 36.dp)
                Column {
                    Text(
                        status.name ?: "User",
                        fontWeight = FontWeight.Bold,
                        fontSize = 15.sp
                    )
                    Text(
                        statusRelative(status.createdAt),
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        },
        text = {
            Column(
                verticalArrangement = Arrangement.spacedBy(10.dp),
                modifier = Modifier.fillMaxWidth()
            ) {
                // Media image if present
                val media = status.media
                if (media != null && media.mime.startsWith("image/") && media.url.isNotBlank()) {
                    AsyncImage(
                        model = media.url,
                        contentDescription = "Status image",
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 80.dp, max = 240.dp)
                            .clip(RoundedCornerShape(12.dp))
                    )
                }

                // Body text
                if (status.body.isNotBlank()) {
                    Text(status.body, fontSize = 14.sp)
                }

                // View & like counts
                Row(
                    horizontalArrangement = Arrangement.spacedBy(16.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        "👁 ${status.viewCount} views",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Text(
                        "❤️ ${status.likeCount} likes",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        },
        confirmButton = {
            Button(
                onClick = onLike,
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFE53E3E)),
                shape = RoundedCornerShape(12.dp)
            ) {
                Text("Like ❤️")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Close") }
        },
        shape = RoundedCornerShape(22.dp)
    )
}

@Composable
fun StatusComposeDialog(onDismiss: () -> Unit, onPost: (String) -> Unit) {
    var text by remember { mutableStateOf("") }
    val accent = Color(0xFF0B8C72)

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Post Status", fontWeight = FontWeight.Bold) },
        text = {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                placeholder = { Text("What's on your mind?") },
                modifier = Modifier.fillMaxWidth(),
                maxLines = 8,
                shape = RoundedCornerShape(13.dp),
                colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = accent)
            )
        },
        confirmButton = {
            Button(
                onClick = { if (text.isNotBlank()) onPost(text) },
                enabled = text.isNotBlank(),
                colors = ButtonDefaults.buttonColors(containerColor = accent),
                shape = RoundedCornerShape(12.dp)
            ) {
                Text("Post")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        },
        shape = RoundedCornerShape(22.dp)
    )
}

private fun statusRelative(iso: String): String {
    return try {
        val sdf = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.getDefault())
        val date = sdf.parse(iso.substringBefore(".")) ?: return iso
        val mins = ((System.currentTimeMillis() - date.time) / 60000).coerceAtLeast(1)
        when {
            mins < 60 -> "${mins}m ago"
            mins < 1440 -> "${mins / 60}h ago"
            else -> "${mins / 1440}d ago"
        }
    } catch (_: Exception) { iso }
}
