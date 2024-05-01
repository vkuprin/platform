import { Analytics } from '@hcengineering/analytics'
import client from '@hcengineering/client'
import core, {
  ClientConnectEvent,
  getCurrentAccount,
  MeasureMetricsContext,
  metricsToString,
  setCurrentAccount,
  versionToString,
  type Account,
  type AccountClient,
  type Client,
  type Version
} from '@hcengineering/core'
import login, { loginId } from '@hcengineering/login'
import { addEventListener, broadcastEvent, getMetadata, getResource, setMetadata } from '@hcengineering/platform'
import presentation, { closeClient, purgeClient, refreshClient, setClient } from '@hcengineering/presentation'
import {
  fetchMetadataLocalStorage,
  getCurrentLocation,
  locationStorageKeyId,
  navigate,
  networkStatus,
  setMetadataLocalStorage
} from '@hcengineering/ui'
import { writable } from 'svelte/store'
import plugin from './plugin'
import { workspaceCreating } from './utils'

export const versionError = writable<string | undefined>(undefined)

let _token: string | undefined
let _client: AccountClient | undefined
let _clientSet: boolean = false

addEventListener(client.event.NetworkRequests, async (event: string, val: number) => {
  networkStatus.set(val)
})

export async function disconnect (): Promise<void> {
  if (_client !== undefined) {
    await _client.close()
    _client = undefined
    _clientSet = false
  }
}

export async function connect (title: string): Promise<Client | undefined> {
  const ctx = new MeasureMetricsContext('connect', {})
  const loc = getCurrentLocation()
  const ws = loc.path[1]
  if (ws === undefined) {
    const lastLoc = localStorage.getItem(locationStorageKeyId)
    if (lastLoc !== null) {
      const lastLocObj = JSON.parse(lastLoc)
      if (lastLocObj.path !== undefined && lastLocObj.path[0] === loc.path[0]) {
        navigate(lastLocObj)
        return
      }
    } else {
      navigate({
        path: [loginId]
      })
      return
    }
  }
  const tokens: Record<string, string> = fetchMetadataLocalStorage(login.metadata.LoginTokens) ?? {}
  let token = tokens[ws]

  if (token === undefined && getMetadata(presentation.metadata.Token) !== undefined) {
    const selectWorkspace = await getResource(login.function.SelectWorkspace)
    const loginInfo = await ctx.with('select-workspace', {}, async () => (await selectWorkspace(ws))[1])
    if (loginInfo !== undefined) {
      tokens[ws] = loginInfo.token
      token = loginInfo.token
      setMetadataLocalStorage(login.metadata.LoginTokens, tokens)
    }
  }
  setMetadata(presentation.metadata.Token, token)

  const fetchWorkspace = await getResource(login.function.FetchWorkspace)
  let loginInfo = await ctx.with('select-workspace', {}, async () => (await fetchWorkspace(ws))[1])
  if (loginInfo?.creating === true) {
    while (true) {
      workspaceCreating.set(loginInfo?.createProgress ?? 0)
      loginInfo = await ctx.with('select-workspace', {}, async () => (await fetchWorkspace(ws))[1])
      workspaceCreating.set(loginInfo?.createProgress)
      if (loginInfo?.creating === false) {
        workspaceCreating.set(-1)
        break
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 1000))
    }
  }

  document.cookie =
    encodeURIComponent(presentation.metadata.Token.replaceAll(':', '-')) + '=' + encodeURIComponent(token) + '; path=/'

  const endpoint = fetchMetadataLocalStorage(login.metadata.LoginEndpoint)
  const email = fetchMetadataLocalStorage(login.metadata.LoginEmail)
  if (token === undefined || endpoint === null || email === null) {
    const navigateUrl = encodeURIComponent(JSON.stringify(loc))
    navigate({
      path: [loginId],
      query: { navigateUrl }
    })
    return
  }

  let tokenChanged = false

  if (_token !== token && _client !== undefined) {
    // We need to flush all data from memory
    await ctx.with('purge-client', {}, async () => {
      await purgeClient()
    })
    await ctx.with('close previous client', {}, async () => {
      await _client?.close()
    })
    _client = undefined
    tokenChanged = true
  }
  if (_client !== undefined) {
    return _client
  }
  _token = token

  let version: Version | undefined
  let serverEndpoint = endpoint.replace(/^ws/g, 'http')
  if (serverEndpoint.endsWith('/')) {
    serverEndpoint = serverEndpoint.substring(0, serverEndpoint.length - 1)
  }
  const clientFactory = await getResource(client.function.GetClient)
  const newClient = await ctx.with(
    'create-client',
    {},
    async (ctx) =>
      await clientFactory(
        token,
        endpoint,
        () => {
          location.reload()
        },
        () => {
          clearMetadata()
          navigate({
            path: [loginId],
            query: {}
          })
        },
        // We need to refresh all active live queries and clear old queries.
        (event: ClientConnectEvent, data: any) => {
          console.log('WorkbenchClient: onConnect', event)
          if (event === ClientConnectEvent.Maintenance) {
            if (data != null && data.total !== 0) {
              versionError.set(`Maintenance ${Math.floor((100 / data.total) * (data.total - data.toProcess))}%`)
            } else {
              versionError.set('Maintenance...')
            }
            return
          }
          try {
            if ((_clientSet && event === ClientConnectEvent.Connected) || event === ClientConnectEvent.Refresh) {
              void ctx.with('refresh client', {}, async () => {
                await refreshClient(tokenChanged)
              })
              tokenChanged = false
            }

            if (event === ClientConnectEvent.Upgraded) {
              window.location.reload()
            }

            void (async () => {
              if (_client !== undefined) {
                const newVersion = await ctx.with(
                  'find-version',
                  {},
                  async () => await newClient.findOne<Version>(core.class.Version, {})
                )
                console.log('Reconnect Model version', newVersion)

                const currentVersionStr = versionToString(version as Version)
                const reconnectVersionStr = versionToString(newVersion as Version)

                if (currentVersionStr !== reconnectVersionStr) {
                  // It seems upgrade happened
                  // location.reload()
                  versionError.set(`${currentVersionStr} != ${reconnectVersionStr}`)
                }
                const serverVersion: { version: string } = await ctx.with(
                  'fetch-server-version',
                  {},
                  async () => await (await fetch(serverEndpoint + '/api/v1/version', {})).json()
                )

                console.log(
                  'Server version',
                  serverVersion.version,
                  version !== undefined ? versionToString(version) : ''
                )
                if (serverVersion.version !== '' && serverVersion.version !== currentVersionStr) {
                  versionError.set(`${currentVersionStr} => ${serverVersion.version}`)
                } else {
                  versionError.set(undefined)
                }
              }
            })()
          } catch (err) {
            console.error(err)
          }
        },
        ctx
      )
  )

  _client = newClient
  console.log('logging in as', email)

  let me: Account | undefined = await ctx.with('get-account', {}, async () => await newClient.getAccount())
  if (me === undefined) {
    me = await createEmployee(ctx, ws, me, newClient)
  }
  if (me !== undefined) {
    Analytics.setUser(me.email)
    Analytics.setTag('workspace', ws)
    console.log('login: employee account', me)
    setCurrentAccount(me)
  } else {
    console.error('WARNING: no employee account found.')

    clearMetadata()
    navigate({
      path: [loginId],
      query: { navigateUrl: encodeURIComponent(JSON.stringify(getCurrentLocation())) }
    })

    // Update on connect, so it will be triggered
    _clientSet = true
    const client = _client
    await ctx.with('set-client', {}, async () => {
      await setClient(client)
    })
    return
  }
  try {
    version = await ctx.with(
      'find-model-version',
      {},
      async () => await newClient.findOne<Version>(core.class.Version, {})
    )
    console.log('Model version', version)

    const requiredVersion = getMetadata(presentation.metadata.RequiredVersion)
    if (requiredVersion !== undefined && version !== undefined && requiredVersion !== '') {
      console.log('checking min model version', requiredVersion)
      const versionStr = versionToString(version)

      if (version === undefined || requiredVersion !== versionStr) {
        versionError.set(`${versionStr} => ${requiredVersion}`)
        return undefined
      }
    }

    try {
      const serverVersion: { version: string } = await ctx.with(
        'find-server-version',
        {},
        async () => await (await fetch(serverEndpoint + '/api/v1/version', {})).json()
      )

      console.log('Server version', serverVersion.version, version !== undefined ? versionToString(version) : '')
      if (
        serverVersion.version !== '' &&
        (version === undefined || serverVersion.version !== versionToString(version))
      ) {
        const versionStr = version !== undefined ? versionToString(version) : 'unknown'
        versionError.set(`${versionStr} => ${serverVersion.version}`)
        return
      }
    } catch (err: any) {
      versionError.set('server version not available')
      return
    }
  } catch (err: any) {
    console.error(err)
    Analytics.handleError(err)
    const requiredVersion = getMetadata(presentation.metadata.RequiredVersion)
    console.log('checking min model version', requiredVersion)
    if (requiredVersion !== undefined) {
      versionError.set(`'unknown' => ${requiredVersion}`)
      return undefined
    }
  }

  versionError.set(undefined)

  // Update window title
  document.title = [ws, title].filter((it) => it).join(' - ')
  _clientSet = true
  await ctx.with('set-client', {}, async () => {
    await setClient(newClient)
  })
  await ctx.with('broadcast-connected', {}, async () => {
    await broadcastEvent(plugin.event.NotifyConnection, getCurrentAccount())
  })
  console.log(metricsToString(ctx.metrics, 'connect', 50))
  return newClient
}

async function createEmployee (
  ctx: MeasureMetricsContext,
  ws: string,
  me: Account,
  newClient: AccountClient
): Promise<Account | undefined> {
  const createEmployee = await getResource(login.function.CreateEmployee)
  await ctx.with('create-missing-employee', {}, async () => {
    await createEmployee(ws)
  })
  for (let i = 0; i < 5; i++) {
    me = await ctx.with('get-account', {}, async () => await newClient.getAccount())
    if (me !== undefined) {
      break
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100)
    })
  }
  return me
}

function clearMetadata (): void {
  const tokens = fetchMetadataLocalStorage(login.metadata.LoginTokens)
  if (tokens !== null) {
    const loc = getCurrentLocation()
    // eslint-disable-next-line
    delete tokens[loc.path[1]]
    setMetadataLocalStorage(login.metadata.LoginTokens, tokens)
  }
  setMetadata(presentation.metadata.Token, null)
  setMetadataLocalStorage(login.metadata.LastToken, null)
  document.cookie =
    encodeURIComponent(presentation.metadata.Token.replaceAll(':', '-')) + '=' + encodeURIComponent('') + '; path=/'
  setMetadataLocalStorage(login.metadata.LoginEndpoint, null)
  setMetadataLocalStorage(login.metadata.LoginEmail, null)
  void closeClient()
}
