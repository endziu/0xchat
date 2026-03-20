export interface Message {
  id: string
  sender: string
  recipient: string
  ct_recipient: string
  ephemeral_pub_recipient: string
  iv_recipient: string
  ct_sender: string
  ephemeral_pub_sender: string
  iv_sender: string
  ttl: number
  created_at: number
  expires_at: number
}

export interface Conversation {
  address: string
  last_message_at: number
  unread_count: number
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem('eth_chat_token')
  const headers = new Headers(options.headers)
  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }
  
  const res = await fetch(path, { ...options, headers })
  if (res.status === 401) {
    localStorage.removeItem('eth_chat_token')
    // Trigger a page reload or state update to handle logout
    if (!path.includes('/api/auth/')) {
      window.location.reload() 
    }
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || res.statusText)
  }
  
  if (res.status === 204) return {} as T
  return res.json()
}

export const api = {
  register: (address: string, pubkey: string, signature: string) =>
    request('/api/register', {
      method: 'POST',
      body: JSON.stringify({ address, pubkey, signature }),
      headers: { 'Content-Type': 'application/json' },
    }),

  getPubkey: (address: string): Promise<{ pubkey: string | null }> =>
    request(`/api/pubkey/${address}`),

  getChallenge: (address: string): Promise<{ challenge: string; nonce: string }> =>
    request('/api/auth/challenge', {
      method: 'POST',
      body: JSON.stringify({ address }),
      headers: { 'Content-Type': 'application/json' },
    }),

  createSession: (address: string, signature: string, nonce: string): Promise<{ token: string }> =>
    request('/api/auth/session', {
      method: 'POST',
      body: JSON.stringify({ address, signature, nonce }),
      headers: { 'Content-Type': 'application/json' },
    }),

  sendMessage: (data: {
    recipient: string
    ct_recipient: string
    ephemeral_pub_recipient: string
    iv_recipient: string
    ct_sender: string
    ephemeral_pub_sender: string
    iv_sender: string
    ttl: number
  }) =>
    request('/api/messages', {
      method: 'POST',
      body: JSON.stringify(data),
      headers: { 'Content-Type': 'application/json' },
    }),

  getMessages: (address: string): Promise<{ messages: Message[] }> =>
    request(`/api/messages/${address}`),

  getConversations: (): Promise<{ conversations: Conversation[] }> =>
    request('/api/conversations'),
}
