# Apollo Phoenix Websocket

<a href="https://travis-ci.org/vic/apollo-phoenix-websocket"><img src="https://travis-ci.org/vic/apollo-phoenix-websocket.svg"></a>

This node module implements an [Apollo GraphQL Network Layer] using [Phoenix Channels]

## Installation

```shell
npm install --save apollo-phoenix-websocket
```

## Usage

```javascript
import ApolloClient from 'apollo-client'
import {createNetworkInterface} from 'apollo-phoenix-websocket'

// See the Options section
const networkInterface = createNetworkInterface({
  uri: 'ws://localhost:4000/socket',
  channel: {
    topic: 'gql:query'
  }
})

const apollo = new ApolloClient({networkInterface})
```

## Options

The `networkInterface` expects an object with at least the following
properties:

- `uri`: The Phoenix websocket uri to connect into
- `channel.topic`: A topic name where graphql queries will be sent

These other have default values:

- `params`: The params sent to Phoenix when connecting to the socket
- `channel.params`: The params sent to Phoenix when joining the channel
- `channel.in_msg`: Name of the `handle_in` message on the channel, defaults to 'gql'

- `Socket`: A Phoenix Socket js implementation, if not specified it will
            use the reference implementation from the [Phoenix Framework](https://github.com/phoenixframework/phoenix). If used within a Phoenix project, the generated `web/static/js/socket.js` can be used by passing as a parameter here.
- `logger`: A function or `true` used for debugging.

## Middlewares

You can use middlewares with `use` just like with
the standard apollo network interface.

```javascript
networkInterface.use([{
  applyMiddleware({request, options}, next) {
    // Here you can modify the interface options, for example
    // you can change the socket/channel that will handle the request
    // For example for a channel expecting authenticated queries
    options.channel.topic = "gql:secured"
    options.channel.params = {token: "phoenix_token"}

    // Or Modify the request
    request.variables = {name: 'Luke'}

    next()
  }
}])
```

## Afterware

You can use afterwares with `useAfter` just like the standard
apollo network interface. An example use-case is for error handling:

```javascript
networkInterface.useAfter([{
  applyAfterware({response, options}, next) {
    // throw an error that will trigger your error handler
    if (response.error) {
      throw new Error(response.error)
    }
    next();
  }
}])
```

## Phoenix Channel

This example shows how you could use [Absinthe] to run incomming queries

```javascript
const options = {
  uri: 'ws://localhost:4000/socket',
  channel: {
    topic: 'gql:query',
    params: {foo: true},
    in_msg: 'run'
  }
}
```

```elixir
defmodule MyApp.GQL.Channel do
  use Phoenix.Channel

  def join("gql:query", _params = %{"foo" => true}, socket) do
    {:ok, socket}
  end

  def handle_in("run", params = %{"query" => query}, socket) do
    variables = Map.get(params, "variables", %{})
    options = [variables: variables]
    {:ok, result} = Absinthe.run(query, MyApp.GQL.Schema, options)
    {:reply, {:ok, result}, socket}
  end
end
```

# Made with love <3

If you want to provide feedback or even better if you want to contribute some code feel free to open a [new issue]. 
Possible thanks to the awesome work of [our contributors].


[Apollo GraphQL Network Layer]: http://dev.apollodata.com/core/network.html
[Phoenix Channels]: http://www.phoenixframework.org/docs/channels
[Absinthe]: http://absinthe-graphql.org/
[new issue]: https://github.com/vic/apollo-phoenix-websocket/issues
[our contributors]: https://github.com/vic/apollo-phoenix-websocket/graphs/contributors
