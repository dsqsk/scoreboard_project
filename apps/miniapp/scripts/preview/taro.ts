import { useEffect } from 'react'

const navigate = async ({ url }: { url: string }) => {
  location.hash = url
}
export const useDidShow = (callback: () => void) =>
  useEffect(() => {
    callback()
  }, [])
export const useDidHide = (_callback: () => void) => {}
export const useUnload = (callback: () => void) => useEffect(() => () => callback(), [])
export const useShareAppMessage = (_callback: unknown) => {}
export function useRouter() {
  const route = location.hash.slice(1) || '/pages/index/index'
  return { params: Object.fromEntries(new URLSearchParams(route.split('?')[1] ?? '')) }
}
export default {
  navigateTo: navigate,
  redirectTo: navigate,
  reLaunch: navigate,
  getStorageSync(key: string) {
    try {
      return JSON.parse(localStorage.getItem(key) ?? 'null')
    } catch {
      return null
    }
  },
  setStorageSync(key: string, value: unknown) {
    localStorage.setItem(key, JSON.stringify(value))
  },
  removeStorageSync(key: string) {
    localStorage.removeItem(key)
  },
  setClipboardData: async ({ data }: { data: string }) => navigator.clipboard.writeText(data),
  onNetworkStatusChange() {},
  offNetworkStatusChange() {},
  getNetworkType: async () => ({ networkType: 'wifi' }),
  showModal: async ({ title, content }: { title: string; content: string }) => {
    alert(`${title}：${content}`)
    return { confirm: true }
  },
  cloud: {
    init() {
      throw new Error('Cloud is unavailable in DOM preview')
    },
  },
}
