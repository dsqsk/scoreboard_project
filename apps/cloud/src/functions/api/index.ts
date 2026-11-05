import { foundationRequestSchema } from '@scoreboard/shared'
import { getCloud, requireWechatIdentity } from '../../infrastructure/cloud'
import { defineHandler } from '../../infrastructure/handler'
import { createWxStore, type WxDatabase, type WxStoreObserver } from '../../repositories/wx-store'
import { createFoundation } from '../../services/foundation'
import { validateAvatarContent } from '../../services/avatar'
import { AppError } from '../../infrastructure/errors'
import { observeHandler } from '../../infrastructure/observe-handler'
import { profileDatabase } from '../../infrastructure/database-profile'

const handle = (observer: WxStoreObserver) =>
  defineHandler(foundationRequestSchema, async (request) => {
    const caller = requireWechatIdentity()
    // The installed SDK honors throwOnNotFound; the community types omit this option.
    const options = { throwOnNotFound: false }
    const database = getCloud().database(options)
    return createFoundation({
      store: createWxStore(database as unknown as WxDatabase, observer),
      avatarEnvironmentId:
        process.env.TCB_ENV || process.env.SCF_NAMESPACE || getCloud().getWXContext().ENV,
      validateAvatar: async (fileId) => {
        let content: Buffer
        try {
          content = (await getCloud().downloadFile({ fileID: fileId })).fileContent
        } catch {
          throw new AppError('INVALID_ARGUMENT', '头像无法读取，请重新上传后保存')
        }
        validateAvatarContent(content)
      },
    }).dispatch(request, caller)
  })

const actions = new Set(foundationRequestSchema.options.map((option) => option.shape.action.value))
export const main = observeHandler(
  profileDatabase(
    (event, observer) => handle(observer)(event),
    actions,
    (profile) => console.info(JSON.stringify(profile)),
  ),
  actions,
  (timing) => console.info(JSON.stringify(timing)),
)
