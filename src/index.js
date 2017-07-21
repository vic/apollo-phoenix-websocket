import R from 'ramda'
import {printRequest} from 'apollo-client/transport/networkInterface'
import {Socket as PhoenixSocket} from 'phoenix'

export const absinthe = {
  channel: {
    topic: '__absinthe__:control',
    event: 'doc'
  },
  subscription: (subResponse) => ({
    topic: subResponse.subscriptionId,
    event: 'subscription:data',
    off: (subChannel, controlChannel) => {
      controlChannel.push('unsubscribe', subResponse.subscriptionId)
    }
  })
}

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

For example, if you are using Absinthe subscriptions, this function can be like:

   ({subscriptionId}) => ({topic: subscriptionId, event: 'subscription:data'})
`

const subscriptionOptions = (options) => subscriptionResponse => new Promise((resolve, reject) => {
  const {subscription} = options
  const subOptions = typeof subscription === 'function' ? subscription(subscriptionResponse) : {}
  if (typeof subOptions !== 'object' || !subOptions.topic || !subOptions.event) {
    throw NO_SUBSCRIPTION_OPTIONS
  }
  resolve(subOptions)
})

const subscribeToData = ({channel, subOptions, subCallback, responseMiddleware, controlChannel}) => new Promise((resolve, reject) => {
  const {topic, event, off, filter} = subOptions

  const handleData = R.pipeP(
    responseMiddleware,
    responseContext => {
      const {response} = responseContext
      // Apollo expects just the subscription data not all the response
      const {result: {data}} = response
      subCallback(/*error*/ null, data)
      return responseContext
    }
  )

  const filterF = filter || R.always(true)
  const handler = data => filterF(data) && handleData(data)

  const subscription = {
    unsubscribe: _ => {
      channel.off(event, handler)
      typeof off === 'function' && off(channel, controlChannel)
    }
  }

  channel.on(event, handler)
  resolve(subscription)
})

const performSubscribe = ({sockets, subCallback, responseMiddleware}) => ({channel, context}) => {
  const controlChannel = channel
  return R.pipeP(
    performQuery,
    subscriptionOptions(context.options),
    subOptions => R.pipeP(
      _ => senderChannel(sockets)({options: {uri: context.options.uri, channel: subOptions}}),
      ({channel}) => ({channel, subOptions})
    )(),
    ({channel, subOptions}) => subscribeToData({
      channel, controlChannel,
      subOptions, subCallback,
      responseMiddleware})
  )({channel: controlChannel, context})
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

export function createNetworkInterface(ifaceOpts) {
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
    performSubscribe({sockets, subCallback, responseMiddleware})
  )(request)

  return {query, use, useAfter, subscribe}
}
