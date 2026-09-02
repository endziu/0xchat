/** One-shot migration from the old `eth_chat_*` key prefix to `0xchat_*`. */
export function migrateKey(oldKey: string, newKey: string): void {
  if (localStorage.getItem(newKey) !== null) return
  const value = localStorage.getItem(oldKey)
  if (value !== null) {
    localStorage.setItem(newKey, value)
    localStorage.removeItem(oldKey)
  }
}