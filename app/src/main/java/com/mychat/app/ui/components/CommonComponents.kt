package com.mychat.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage

/** Avatar with initials fallback, online dot, and optional status ring */
@Composable
fun UserAvatar(
    name: String,
    dp: String? = null,
    isOnline: Boolean = false,
    hasStatus: Boolean = false,
    size: Dp = 48.dp,
    modifier: Modifier = Modifier
) {
    val accent = Color(0xFF0B8C72)
    val ringColor = if (hasStatus) Color(0xFF22C55E) else Color.Transparent

    Box(
        modifier = modifier
            .size(size + 4.dp)
            .then(
                if (hasStatus) Modifier.border(2.5.dp, ringColor, CircleShape)
                else Modifier
            )
    ) {
        Box(
            modifier = Modifier
                .size(size)
                .clip(CircleShape)
                .background(accent.copy(alpha = 0.14f))
                .align(Alignment.Center),
            contentAlignment = Alignment.Center
        ) {
            if (!dp.isNullOrBlank()) {
                AsyncImage(
                    model = dp,
                    contentDescription = name,
                    modifier = Modifier
                        .fillMaxSize()
                        .clip(CircleShape)
                )
            } else {
                Text(
                    text = name.take(1).uppercase(),
                    color = accent,
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = (size.value * 0.38f).sp
                )
            }
        }

        if (isOnline) {
            Box(
                modifier = Modifier
                    .size(13.dp)
                    .clip(CircleShape)
                    .background(Color(0xFF22C55E))
                    .border(2.dp, MaterialTheme.colorScheme.surface, CircleShape)
                    .align(Alignment.BottomEnd)
            )
        }
    }
}

/** Tick marks for message delivery status */
@Composable
fun TickMarks(deliveredAt: String?, readAt: String?, modifier: Modifier = Modifier) {
    val isRead = !readAt.isNullOrBlank()
    val isDelivered = !deliveredAt.isNullOrBlank()
    Text(
        text = when {
            isRead || isDelivered -> "✓✓"
            else -> "✓"
        },
        color = when {
            isRead -> Color(0xFF2678FF)
            isDelivered -> Color(0xFF0B8C72)
            else -> MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f)
        },
        fontSize = 11.sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = (-1).sp,
        modifier = modifier
    )
}
