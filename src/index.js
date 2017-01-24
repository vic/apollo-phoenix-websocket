import {clone, pipeP, map} from 'ramda'
import {printRequest} from 'apollo-client/transport/networkInterface'
import {Socket as PhoenixSocket} from 'phoenix'

function applyWares (ctx, wares) {
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

function connect(sockets, performWhenConnected, context) {
  const {request, options} = context
  const {uri, channel} = options
  const Socket = options.Socket || PhoenixSocket

  if (! uri) { throw "Missing options.uri" }
  if (! channel) { throw "Missing options.channel" }
  if (! channel.topic) { throw "Missing options.channel.topic" }

  if (options.logger === true) {
    options.logger = (kind, msg, data) =>
      console.log(`Apollo websocket ${kind}: ${msg}`, data)
  }

  if(! sockets[uri]) {
    sockets[uri] = {
      conn: new Socket(uri, options),
      channels: {}
    }
  }

  const socket = sockets[uri]
  let chan = socket.channels[channel.topic]

  function joinChannel(resolve) {
    if (! socket.conn.isConnected()) {
      return socket.conn.connect()
    }
    if (! chan.conn) {
      chan.conn = socket.conn.channel(channel.topic, channel.params || {})
    }
    if (!chan.conn.isJoined() && !chan.conn.isJoining()) {
      chan.conn.join().receive("ok", _ => {
        const queue = chan.queue
        chan.queue = []
        map(performWhenConnected.bind(null, chan), queue)
      }).receive('error', err => {
        chan.conn.leave()
        chan.conn = null
        chan.queue.pop()
        resolve(err)
      })
    }
  }

  return new Promise(function (resolve, reject) {
    if(! chan) {
      chan = socket.channels[channel.topic] = {
        conn: null,
        queue: []
      }
      socket.conn.onOpen(joinChannel.bind(null, resolve))
      socket.conn.onError(err => {
        if (chan.conn && (chan.conn.isJoined() || chan.conn.isJoining())) {
          chan.conn.leave()
        }
        chan.queue = []
        resolve(err)
      })
    }
    if (chan.conn && chan.conn.isJoined()) {
      performWhenConnected(chan, {context, resolve, reject})
    } else {
      chan.queue.push({context, resolve, reject})
      joinChannel(resolve)
    }
  })
}

function performQuery ({conn}, {context, resolve, reject}) {
  const msg = chanMsg(context)
  const payload = printRequest(context.request)
  conn.push(msg, payload)
    .receive("ok", resolve)
    .receive("error", resolve)
    .receive("timeout", reject.bind(null, 'timeout'))
}

function performSubscribe (processReponse, {conn}, {context, resolve, reject}) {
  const msg = chanMsg(context)
  // listen when subscription messages arrive
  conn.on(msg, processReponse)
  // the query will perform the subscription at server
  performQuery({conn}, {context, resolve, reject})
}

function performUnsubscribe (processReponse, {conn}, {context}) {
  const msg = chanMsg(context)
  conn.off(msg, processReponse)
}

function responseData ({response}) {
  return new Promise(function (resolve, reject) {
    if (response.error){
      reject(response)
    } else if (response.data) {
      resolve(response)
    } else {
      reject('No response')
    }
  })
}

function chanMsg(context) {
  return context.options.channel.in_msg || 'gql'
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

  const doQuery = connect.bind(null, sockets, performQuery)
  const query = pipeP(requestMiddleware,
                      doQuery,
                      responseMiddleware,
                      responseData)

  const subscriptions = {}

  function subscribe (request, responseCallback) {
    // An integer that can be used to unsubscribe later
    const subID = new Date().getTime()

    const processReponse = (response) => {
      pipeP(responseMiddleware, responseData)(response)
        .then(responseCallback)
        .catch(responseCallback.bind(null, null))
    }

    subscriptions[subID] = processReponse

    const doSubscribe = connect.bind(
      null, sockets, performSubscribe.bind(null, processReponse))

    pipeP(requestMiddleware, doSubscribe)(request)
      .then(subscribeReponse => null) // processReponse? or discard
      .catch(error => throw error) // could not subscribe

    return subID
  }

  function unsubscribe (subID) {
    const processReponse = subscriptions[subID]
    const doUnsubscribe = connect.bind(
      null, sockets, performUnsubscribe.bind(null, processReponse))
    pipeP(requestMiddleware, doUnsubscribe)({subID})
  }

  return {query, use, useAfter, subscribe, unsubscribe}
}
