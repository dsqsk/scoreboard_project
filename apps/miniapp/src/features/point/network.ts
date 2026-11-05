export function createPointNetworkHandler(ports: {
  isAlive(): boolean
  isVisible(): boolean
  setOnline(online: boolean): void
  refresh(): Promise<void>
}) {
  return ({ isConnected }: { isConnected: boolean }) => {
    if (!ports.isAlive()) return
    // Preserve connectivity while hidden so the next onShow can refresh normally.
    ports.setOnline(isConnected)
    if (isConnected && ports.isVisible()) void ports.refresh()
  }
}
