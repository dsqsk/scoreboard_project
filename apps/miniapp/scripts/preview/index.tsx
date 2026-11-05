import { daAApi } from '../../src/features/da-a/runtime'
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import Home from '../../src/pages/index'
import Join from '../../src/pages/join'
import CreatePoker from '../../src/pages/create-poker'
import Room from '../../src/pages/room'
import { pointApi } from '../../src/features/point/runtime'
import { pokerApi } from '../../src/features/poker/runtime'
import { stores, roomApi } from '../../src/runtime'
import type { createMockRoomApi } from '../../src/modules/room-api/mock'

function Preview() {
  const [route, setRoute] = useState(location.hash)
  const [fault, setFault] = useState('')
  useEffect(() => {
    const update = () => setRoute(location.hash)
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])
  const Component = route.includes('/pages/create-poker/')
    ? CreatePoker
    : route.includes('/pages/join/')
      ? Join
      : route.includes('/pages/room/')
        ? Room
        : Home
  const controls = roomApi as ReturnType<typeof createMockRoomApi>
  return (
    <>
      <header className="preview-header">
        <strong>前端 · DOM走查</strong>
        <span>真实页面源码 / 非微信运行时</span>
      </header>
      <div className="preview-nav">
        <button
          onClick={() => {
            location.hash = '/pages/index/index'
          }}
        >
          ‹ 首页
        </button>
        <span>把分记好</span>
      </div>
      <Component key={route} />
      <details className="preview-tools">
        <summary>开发走查工具</summary>
        <p>仅影响独立Mock，不调用后端。</p>
        <button
          onClick={() => {
            controls.failNext()
            setFault('下一次请求将失败')
          }}
        >
          下一请求失败
        </button>
        <button
          onClick={() => {
            controls.loseNextResponse()
            setFault('下一写入成功后丢失响应')
          }}
        >
          下一写入丢响应
        </button>
        <button
          onClick={() => {
            if ('failNext' in pokerApi && typeof pokerApi.failNext === 'function')
              pokerApi.failNext()
            setFault('下一次扑克保存将失败')
          }}
        >
          下一次扑克保存失败
        </button>
        <button
          onClick={() => {
            if ('loseNextResponse' in pokerApi && typeof pokerApi.loseNextResponse === 'function')
              pokerApi.loseNextResponse()
            setFault('下一次扑克保存丢失响应')
          }}
        >
          下一次扑克保存丢响应
        </button>
        <button
          onClick={() => {
            if ('failNext' in pointApi && typeof pointApi.failNext === 'function')
              pointApi.failNext()
            setFault('下一次打分保存失败')
          }}
        >
          下一次打分保存失败
        </button>
        <button
          onClick={() => {
            if ('loseNextResponse' in pointApi && typeof pointApi.loseNextResponse === 'function')
              pointApi.loseNextResponse()
            setFault('下一次打分保存丢响应')
          }}
        >
          下一次打分保存丢响应
        </button>
        <button
          onClick={() => {
            if ('failNext' in daAApi && typeof daAApi.failNext === 'function') daAApi.failNext()
            setFault('下一次打大A保存将失败')
          }}
        >
          下一次打大A保存失败
        </button>
        <button
          onClick={() => {
            if ('loseNextResponse' in daAApi && typeof daAApi.loseNextResponse === 'function')
              daAApi.loseNextResponse()
            setFault('下一次打大A保存丢失响应')
          }}
        >
          下一次打大A保存丢响应
        </button>
        <button
          onClick={() => {
            void stores.loadRecent()
          }}
        >
          刷新最近房间
        </button>
        <p>{fault}</p>
      </details>
    </>
  )
}
createRoot(document.getElementById('root')!).render(<Preview />)
