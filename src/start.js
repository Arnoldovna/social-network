import React from "react";
import ReactDOM from "react-dom";
import { Welcome } from "./register.js";
import { HashRouter, Route, Link, Switch } from "react-router-dom";
import { App } from "./app.js";
import { createStore, applyMiddleware } from "redux";
import reduxPromise from "redux-promise";
import reducer from "./reducer.js";
import { Provider } from "react-redux";
import { composeWithDevTools } from "redux-devtools-extension";

//socket stuff
import { initSocket } from "./socket.js";

const store = createStore(
  reducer,
  composeWithDevTools(applyMiddleware(reduxPromise))
);

let elem;

if (location.pathname === "/welcome") {
  elem = <Welcome />;
} else {
  elem = (initSocket(store) /* here wird die app in socket gewrappt*/,
  (
    <Provider store={store}>
      <App />
    </Provider>
  ));
}

ReactDOM.render(elem, document.querySelector("main"));

//import___
//Provider from react-redux
//createStore and applyMiddlewar from redux
//reduxPromise from redux-Promise// reducer from ./reducer.js
///composeWithDevTools from redux-deytools-extension

// call createStore passing reducer and result of calling 'composeWithDevtolls and passing it the result of calling 'applyMiddleware and passing it
//reduxPromise
//warp app componenet in 'provider componenet and pass Provider the store as a prop'
