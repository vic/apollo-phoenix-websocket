import {clone, pipeP, map, isEmpty, isNil, either} from 'ramda'
import {printRequest} from 'apollo-client/transport/networkInterface'
import {Socket as PhoenixSocket} from 'phoenix';

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
  const Socket = options.Socket || PhoenixSocket

  if (typeof Socket.constructor === 'function') {
    return new Socket(uri, options)
  } else {
    return Socket(uri, options)
  }
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

const sendQuery = (channel, context) => new Promise((resolve, reject) => {
  const {options, request} = context

  const message = queryMessage(options)
  const payload = printRequest(request)

  channel.conn.push(message, payload)
    .receive('ok', resolve)
    .receive('error', reject)
    .receive('timeout', reject)
})

const subscribeMessage = ({channel}) => channel.subscribeMessage || 'subscribe'

const sendSubscribe = (channel, context) => new Promise((resolve, reject) => {
  const {options, request} = context

  const message = queryMessage(options)
  const payload = printRequest(request)

  channel.conn.push(message, payload)
    .receive('ok', resolve)
    .receive('error', reject)
    .receive('timeout', reject)

})

const perform = (performer, sockets, context) => {
  const {options} = context
  const promise = pipeP(_ => socketConnect(sockets, options),
                        socket => channelJoin(socket, options),
                        channel => performer(channel, context))
  return promise()
    .catch(error => error) // always resolve to let middleware handle errors
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
                      perform.bind(null, sendQuery, sockets),
                      responseMiddleware,
                      responseData)

  const subscribe = (request, subCallback) => {
    const subscribeMiddleware = _ => {
      const subscriptionId = newSubscriptionId()
      const options = clone(ifaceOpts)
      return applyWares({subscriptionId, request, options}, middlewares)
    }


    return pipeP(subscribeMiddleware,
                 perform.bind(null, sendSubscribe, sockets),
                )()
  }

  return {query, use, useAfter, subscribe}
}
