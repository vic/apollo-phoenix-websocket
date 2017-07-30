import R from 'ramda'
import {printRequest} from 'apollo-client/transport/networkInterface'
import {Socket as PhoenixSocket} from 'phoenix'

export const ABSINTHE_OPTIONS = {
  channel: {
    topic: '__absinthe__:control',
    event: 'doc'
  },
  subscription: subResponse => ({
    topic: subResponse.subscriptionId,
    event: 'subscription:data',
    map: payload => payload.result.data,
    off: controlChannel => {
      controlChannel.push('unsubscribe', {
        subscriptionId: subscriptionResponse.subscriptionId
      })
    },
  })
}

export const DEFAULT_OPTIONS = ABSINTHE_OPTIONS

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
    options.logger = (topic, msg, data) => console.log(
      `Apollo websocket ${topic}: ${msg}`, data)
  }

  const {uri} = options
  if (! uri) throw 'Missing apollo websocket options.uri'

  return sockets[uri] || (
    sockets[uri] = {
      conn: createSocket(options),
      channels: {}
    })
}

const getChannel = (socket, channelOptions) => {
  if (!channelOptions || !channelOptions.topic) throw "Missing topic option"
  const {topic, params} = channelOptions
  return socket.channels[topic] ||
    (socket.channels[topic] = socket.conn.channel(topic, params || {}))
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


const channelJoin = (socket, channelOptions) => new Promise((resolve, reject) => {
  const channel = getChannel(socket, channelOptions)
  if (channel.joinedOnce) {
    resolve(channel)
  } else if (!channel.isJoining()){
    channel.join()
      .receive('ok', _ => resolve(channel))
      .receive('error', reject)
      .receive('timeout', reject)
  }
})

const docEvent= ({channel}) => channel.event || channel.in_msg || 'doc'

const alwaysResolve = promiser => (...args) => promiser(...args).catch(err => err)

const performQuery = ({channel, context}) => new Promise((resolve, reject) => {
  const {options, request} = context

  const message = docEvent(options)
  const payload = printRequest(request)

  channel.push(message, payload)
    .receive('ok', resolve)
    .receive('ignore', resolve)
    .receive('error', reject)
    .receive('timeout', reject)
})

const NO_SUBSCRIPTION_OPTIONS = `
expected options.subscription to be a function with signature:

   subscriptionResponse => ({topic, event})

that is, given the server's subscription response, it must return
an object with two things, the topic and the event name
where to expect incoming data for the subscription.

For example, if you are using Absinthe backend, this function can be like:


      subscription: subResponse => ({
        topic: subResponse.subscriptionId,
        event: 'subscription:data',
        map: payload => payload.result.data,
        off: controlChannel => {
          controlChannel.push('unsubscribe', {
            subscriptionId: subResponse.subscriptionId
          })
        }
      })

`

const subscriptionOptions = (options) => subscriptionResponse => new Promise((resolve, reject) => {
  const {subscription} = options
  const subOptions = typeof subscription === 'function' ? subscription(subscriptionResponse) : {}
  if (typeof subOptions !== 'object' || !subOptions.topic || !subOptions.event) {
    throw NO_SUBSCRIPTION_OPTIONS
  }
  resolve(subOptions)
})

const subscribeToFastlane = ({channel, subCallback, responseMiddleware}) => subOptions => new Promise((resolve, reject) => {

  const handleData = R.pipeP(
    payload => Promise.resolve(payload),
    (subOptions.map || R.identity),
    responseMiddleware,
    responseContext => {
      const {response} = responseContext
      subCallback(/*error*/ null, response)
      return responseContext
    })

  const sub = {
    handler: incoming =>
      incoming.topic === subOptions.topic &&
      incoming.event === subOptions.event &&
      handleData(incoming.payload)
  }

  // listen on the socket fastlane
  channel.socket.onMessage(incoming => {
    sub.handler && sub.handler(incoming)
    return incoming
  })

  const unsubscribe = _ => {
    (subOptions.off || R.identity)(channel)
    delete sub.handler
  }

  resolve({unsubscribe})
})

const performSubscribe = ({subCallback, responseMiddleware}) => ({channel, context}) => {
  return R.pipeP(
    performQuery,
    subscriptionOptions(context.options),
    subscribeToFastlane({channel, subCallback, responseMiddleware}),
  )({channel, context})
}

const senderChannel = (sockets) => context => {
  const {options} = context
  return R.pipeP(
    _ => socketConnect(sockets, options),
    socket => channelJoin(socket, options.channel),
    channel => ({channel, context})
  )()
}

const isEmptyOrNil = R.either(R.isEmpty, R.isNil)

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

export function createNetworkInterface(opts) {
  const ifaceOpts = R.mergeDeepRight(DEFAULT_OPTIONS, opts)

  const sockets = {}
  const middlewares = []
  const afterwares = []

  const use = R.map(item => middlewares.push(item))
  const useAfter = R.map(item => afterwares.push(item))

  const requestMiddleware = (request) => {
    const options = R.clone(ifaceOpts)
    return applyWares({request, options}, middlewares)
  }

  const responseMiddleware = (response) => {
    const options = R.clone(ifaceOpts)
    return applyWares({response, options}, afterwares)
  }

  const query = R.pipeP(requestMiddleware,
                      senderChannel(sockets),
                      alwaysResolve(performQuery),
                      responseMiddleware,
                      responseData)

  const subscribe = (request, subCallback) => R.pipeP(
    requestMiddleware,
    senderChannel(sockets),
    performSubscribe({subCallback, responseMiddleware})
  )(request)

  const unsubscribe = subscription => {
    subscription.then(({unsubscribe}) => unsubscribe())
  }

  return {query, use, useAfter, subscribe, unsubscribe}
}
