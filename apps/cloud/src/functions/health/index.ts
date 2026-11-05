import { z } from 'zod'
import { defineHandler } from '../../infrastructure/handler'
import { getHealth } from '../../services/health'

// 公共探活：仅返回静态状态，不读取数据库或用户身份。
export const main = defineHandler(z.object({}).strict(), getHealth)
