import { httpTransport } from '../../platform/backend'
import { createHttpAvatars } from './http-avatars'
export const httpAvatars = createHttpAvatars(httpTransport.post)
