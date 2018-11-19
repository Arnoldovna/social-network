import React from "react";
import { HashRouter, Route, Link } from "react-router-dom";
import { Registration, Login } from "./register.js";
export function About() {
  var currentLocation = location.hash;
  console.log("****about*", currentLocation);
  return (
    <div className="aboutContent">
      <HashRouter>
        <div>
          <img id="loginImg" src="/link.png" />
          <Link id="login" to="/login">
            LOGIN
          </Link>

          <img id="registerImg" src="/link.png" />
          <Link id="register" to="/">
            SIGN UP
          </Link>

          <Route exact path="/" component={Registration} />

          <Route exact path="/login" component={Login} />
        </div>
      </HashRouter>

      <p className="aboutTitle">ABOUT:</p>

      <p>
        'Let's Chat!' is a project which showcases basic features of a social
        media plattform. <br /> <br />
        With an account you can create a profile, add a bio and upload a profile
        picture. You can view other user's profiles and make friend requests. A
        chatroom makes the network experience complete.
        <br /> <br />This project has been developed using following
        technologies:
      </p>
      <div className="technologieContainer">
        <a href="#">React.js</a>
        <a href="#">Redux</a>
        <a href="#">Socket.io</a>
      </div>
    </div>
  );
}
