import sinon from 'sinon'
import {assert} from 'chai'
import {createNetworkInterface} from '../src'
import {clone, merge} from 'ramda'
import gql from 'graphql-tag'

describe('phoenix websockets networkInterface', function () {

  const query = gql`{ example }`
  const options = {
    uri: 'ws://example.com/socket',
    channel: {topic: 'gql:query'},
    //logger: true
  }

  beforeEach(function () {
    options.transport = FakeTransport()
  })

  it('supports adding middleware with use', function (done) {
    const iface = createNetworkInterface(options)
    options.transport
      .addReply(_ => ({status: "ok", response: {}}))
      .addReply(payload => ({status: "ok", response: {data: payload}}))

    const applyMiddleware = function (ctx, next) {
      ctx.request.applied = true
      next()
    }
    iface.use([{applyMiddleware}])

    iface.query({query}).then(({data}) => {
      assert(data.applied)
      done()
    }).catch(console.log)
  })

  it('supports adding afterware with useAfter', function (done) {
    const iface = createNetworkInterface(options)
    options.transport
      .addReply(_ => ({status: "ok", response: {}}))
      .addReply(payload => ({status: "ok", response: {data: payload}}))

    const applyMiddleware = function (ctx, next) {
      ctx.response = {data: {modified: true}}
      next()
    }
    iface.useAfter([{applyMiddleware}])

    iface.query({query}).then(({data}) => {
      assert.deepEqual(data, {modified: true})
      done()
    }).catch(console.log)
  })

  it('rejects if not possible to connect socket', function (done) {
    const iface = createNetworkInterface(options)
    options.transport
      .addReply(_ => ({status: 'error', response: 'socket not connected'}))
      .addReply(_ => ({status: 'ok', response: "socket leaved"}))
    iface.query({query}).catch(error => {
      assert.equal("socket not connected", error)
      done()
    })
  })

  it('rejects if not possible to join channel', function (done) {
    const iface = createNetworkInterface(options)
    options.transport
      .addReply(_ => ({status: 'ok', response: 'socket connected'}))
      .addReply(_ => ({status: 'error', response: 'channel join error'}))
    iface.query({query}).catch(error => {
      assert.equal('channel join error', error)
      done()
    })
  })

  it('expects server to return data or error', function (done) {
    const iface = createNetworkInterface(options)
    options.transport
      .addReply(_ => ({status: "ok", response: {}}))
      .addReply(payload => ({status: "ok", response: {}}))
    iface.query({query}).catch(error => {
      assert.equal('No response', error)
      done()
    })
  })

  it('query resolves with server data', function (done) {
    const iface = createNetworkInterface(options)
    options.transport
      .addReply(_ => ({status: "ok", response: {}}))
      .addReply(payload => ({status: "ok", response: {data: 22}}))
    iface.query({query}).then(({data}) => {
      assert.equal(22, data)
      done()
    })
  })

  it('query rejects with server error', function (done) {
    const iface = createNetworkInterface(options)
    options.transport
      .addReply(_ => ({status: "ok", response: {}}))
      .addReply(payload => ({status: "ok", response: {error: 22}}))
    iface.query({query}).catch(({error}) => {
      assert.equal(22, error)
      done()
    })
  })

})

function FakeTransport () {
  const SOCKET_STATES = {connecting: 0, open: 1, closing: 2, closed: 3}

  function transport (endpointURL) {
    this.skipHeartbeat = true
    this.endpointURL = endpointURL
    this.readyState = SOCKET_STATES.closed
    this.send = function send(data) {
      data = JSON.parse(data)
      const resp = clone(data)
      resp.event = "phx_reply"
      resp.payload = transport.replies.shift()(data.payload)
      const message = JSON.stringify(resp)
      this.onmessage({data: message})
    }.bind(this)

    this._open = _ => {
      this.readyState = SOCKET_STATES.open
      this.onopen()
    }
    setTimeout(this._open, 0)
  }

  transport.replies = []
  transport.addReply = (reply) => {
    transport.replies.push(reply)
    return transport
  }

  return transport
}
