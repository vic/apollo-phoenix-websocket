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


const sendQuery = (channel, context) => new Promise((resolve, reject) => {
  const {options, request} = context

  const msg = options.channel.in_msg || 'gql'
  const payload = printRequest(request)

  channel.conn.push(msg, payload)
    .receive('ok', resolve)
    .receive('error', reject)
    .receive('timeout', reject)
})

function executeQuery(sockets, context) {
  return new Promise(function (resolve, reject) {
    const {request, options} = context

    const queryPromise = pipeP(
      _ => socketConnect(sockets, options),
      socket => channelJoin(socket, options),
      channel => sendQuery(channel, context))

    // let middleware handle any error
    return queryPromise().then(resolve, resolve)
  })
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
                      executeQuery.bind(null, sockets),
                      responseMiddleware,
                      responseData)

  return {query, use, useAfter}
}
