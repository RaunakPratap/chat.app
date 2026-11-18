export function shouldAutoRequestNotifications({
  permission,
  hasNotification,
  hasServiceWorker,
  isSecureContext,
  userGesture,
}) {
  if (!hasNotification || !hasServiceWorker || !isSecureContext) return false;
  if (permission !== 'default') return false;
  return !!userGesture;
}
