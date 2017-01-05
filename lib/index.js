'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createNetworkInterface = createNetworkInterface;

var _phoenix = require('./phoenix');

var _ramda = require('ramda');

var _networkInterface = require('apollo-client/transport/networkInterface');

function applyWares(ctx, wares) {
  return new Promise(function (resolve, reject) {
    var queue = function queue(funcs, scope) {
      var next = function next() {
        if (funcs.length > 0) {
          var f = funcs.shift();
          f.applyMiddleware.apply(scope, [ctx, next]);
        } else {
          resolve(ctx);
        }
      };
      next();
    };
    queue(wares.slice());
  });
}

function executeQuery(ifaceOpts) {

  var socketOptions = {
    params: ifaceOpts.params,
    logger: function logger(kind, msg, data) {
      console.log('Apollo websocket ' + kind + ': ' + msg, data);
    }
  };

  var queryQueue = [];
  var channel = void 0;
  var socket = new _phoenix.Socket(ifaceOpts.uri, socketOptions);

  socket.onOpen(function (_) {
    channel = socket.channel('gql:query');
    joinChannel();
  });

  var joinChannel = function joinChannel() {
    channel.join().receive("ok", function (response) {
      var queue = queryQueue;
      queryQueue = [];
      queue.forEach(performQuery);
    });
  };

  var performQuery = function performQuery(_ref) {
    var context = _ref.context,
        resolve = _ref.resolve,
        reject = _ref.reject;

    context.request = (0, _networkInterface.printRequest)(context.request);
    channel.push("query", context).receive("ok", function (response) {
      resolve(response);
    }).receive("error", function (reasons) {
      reject(reasons);
    }).receive("timeout", function (_) {
      reject("timeout");
    });
  };

  return function queryExecutor(context) {
    return new Promise(function (resolve, reject) {
      if (channel && channel.isJoined()) {
        performQuery({ context: context, resolve: resolve, reject: reject });
      } else if (!socket.isConnected()) {
        queryQueue.push({ context: context, resolve: resolve, reject: reject });
        socket.connect();
      } else if (channel && !channel.isJoined()) {
        queryQueue.push({ context: context, resolve: resolve, reject: reject });
        joinChannel();
      }
    });
  };
}

function createNetworkInterface(ifaceOpts) {
  var middlewares = [];
  var afterwares = [];

  var use = function use(wares) {
    return wares.forEach(function (item) {
      return middlewares.push(item);
    });
  };
  var afterUse = function afterUse(wares) {
    return wares.forEach(function (item) {
      return afterwares.push(item);
    });
  };

  var requestMiddleware = function requestMiddleware(request) {
    var options = (0, _ramda.clone)(ifaceOpts);
    return applyWares({ request: request, options: options }, middlewares);
  };

  var responseMiddleware = function responseMiddleware(response) {
    var options = (0, _ramda.clone)(ifaceOpts);
    return applyWares({ response: response, options: options }, afterwares);
  };

  var responseData = function responseData(_ref2) {
    var response = _ref2.response;

    return new Promise(function (resolve, reject) {
      if (response.data) {
        resolve(response);
      } else {
        reject(response.error || "No response");
      }
    });
  };

  var query = (0, _ramda.pipeP)(requestMiddleware, executeQuery(ifaceOpts), responseMiddleware, responseData);

  return { query: query, use: use, afterUse: afterUse };
}