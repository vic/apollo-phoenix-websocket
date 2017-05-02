import {clone, pipeP, map, isEmpty, isNil, either} from 'ramda'
import {printRequest} from 'apollo-client/transport/networkInterface'
import {Socket as PhoenixSocket} from 'phoenix'

const applyWares = (ctx, wares) => {
  return new Promise(function (resolve, reject) {
    const queue = function (funcs, scope) {
      const next = function () {
        if (funcs.length > 0) {
          const f = funcs.shift()
          f && (f.applyMiddleware || f.applyAfterware).apply(scope, [ctx, next])
        }
        else {
          resolve(ctx)
        }
      }
      next()
    }
    queue(wares.slice())
  })
}

const createSocket = (options) => {
  const {uri} = options
  const Socket = options.Socket || ((...args) => new PhoenixSocket(...args))
  return Socket(uri, options)
}

const getSocket = (sockets, options) => {
  if (options.logger === true) {
    options.logger = (kind, msg, data) => console.log(
      `Apollo websocket ${kind}: ${msg}`, data)
  }

  const {uri} = options
  if (! uri) throw 'Missing apollo websocket options.uri'

  if (sockets[uri]) {
    return sockets[uri]
  }

  return sockets[uri] = {
    conn: createSocket(options),
    channels: {}
  }
}

const getChannel = (socket, options) => {
  const {channel} = options

  if (! channel) throw "Missing options.channel"
  if (! channel.topic) throw "Missing options.channel.topic"

  if (socket.channels[channel.topic]) {
    return socket.channels[channel.topic]
  } else {
    return socket.channels[channel.topic] = {
      conn: socket.conn.channel(channel.topic,
                                channel.params || {}),
      queue: []
    }
  }
}

const socketConnect = (sockets, options) => new Promise((resolve, reject) => {
  const socket = getSocket(sockets, options)
  if (socket.conn.isConnected()) {
    resolve(socket)
  } else {
    socket.conn.onOpen(_ => resolve(socket))
    socket.conn.onError(reject)
    socket.conn.connect()
  }
})


const channelJoin = (socket, options) => new Promise((resolve, reject) => {
  const channel = getChannel(socket, options)
  if (channel.conn.joinedOnce) {
    resolve(channel)
  } else if (!channel.conn.isJoining()){
    channel.conn.join()
      .receive('ok', _ => resolve(channel))
      .receive('error', reject)
      .receive('timeout', reject)
  }
})

const queryMessage = ({channel}) => channel.queryMessage || channel.in_msg || 'gql'

const alwaysResolve = promiser => (...args) => promiser(...args).catch(err => err)

const performQuery = ({channel, context}) => new Promise((resolve, reject) => {
  const {options, request} = context

  const message = queryMessage(options)
  const payload = printRequest(request)

  channel.conn.push(message, payload)
    .receive('ok', resolve)
    .receive('ignore', resolve)
    .receive('error', reject)
    .receive('timeout', reject)
})

const subscriptionEventName = ({context}) => subscriptionResponse => new Promise((resolve, reject) => {
  const {subscriptionEvent} = context.options.channel
  if (typeof subscriptionEvent !== 'function') {
    throw `
expected options.channel.subscriptionEvent to be a function with signature:

  (subscriptionResponse, {options}) => subscriptionEventName
`
  }
  resolve(subscriptionEvent(subscriptionResponse, context))
})

const subscribeToEvent = (subMeta) => eventName => new Promise((resolve, reject) => {
  const {channel, context, subCallback, responseMiddleware} = subMeta
  const handler = eventData => {
    pipeP(
      responseMiddleware,
      responseContext => {
        const {response} = responseContext
        subCallback(/*error*/ null, response)
        return responseContext
      }
    )(eventData)
  }
  channel.conn.on(eventName, handler)
  const subscription = {
    // TODO: send unsubscribe message to server
    unsubscribe: _ => channel.conn.off(eventName, handler)
  }
  resolve(subscription)
})

const performSubscribe = ({subCallback, responseMiddleware}) => ({channel, context}) => {
  const subMeta = {channel, context, subCallback, responseMiddleware}
  return pipeP(
    performQuery,
    subscriptionEventName(subMeta),
    subscribeToEvent(subMeta)
  )({channel, context})
}

const senderChannel = (sockets) => context => {
  const {options} = context
  return pipeP(
    _ => socketConnect(sockets, options),
    socket => channelJoin(socket, options),
    channel => ({channel, context})
  )()
}

const isEmptyOrNil = either(isEmpty, isNil)

const responseData = ({response}) => {
  return new Promise(function (resolve, reject) {
    if (isEmptyOrNil(response)) {
      reject('No response')
    } else if (!isEmptyOrNil(response.data)) {
      resolve(response)
    } else {
      reject(response)
    }
  })
}

const newSubscriptionId = _ =>
      (Date.now().toString(36) + Math.random().toString(36).substr(2, 8)).toUpperCase()

export function createNetworkInterface(ifaceOpts) {
  const sockets = {}
  const middlewares = []
  const afterwares = []

  const use = map(item => middlewares.push(item))
  const useAfter = map(item => afterwares.push(item))

  const requestMiddleware = (request) => {
    const options = clone(ifaceOpts)
    return applyWares({request, options}, middlewares)
  }

  const responseMiddleware = (response) => {
    const options = clone(ifaceOpts)
    return applyWares({response, options}, afterwares)
  }

  const query = pipeP(requestMiddleware,
                      senderChannel(sockets),
                      alwaysResolve(performQuery),
                      responseMiddleware,
                      responseData)

  const subscribe = (request, subCallback) => {
    return pipeP(
      requestMiddleware,
      senderChannel(sockets),
      performSubscribe({subCallback, responseMiddleware})
    )(request)
  }

  return {query, use, useAfter, subscribe}
}
