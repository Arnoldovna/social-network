import React from "react";
import axios from "./axios";
import { HashRouter, Route, Link } from "react-router-dom";
import { About } from "./about.js";

export class Welcome extends React.Component {
  constructor() {
    super();
  }
  componentDidMount() {}

  render() {
    var currentLocation = location.hash;
    console.log("****welcome*", currentLocation);

    return (
      <div className="flexbox">
        <div className="welcome">
          <img className="networkImg" src="/network_white.png" />
          <HashRouter>
            <div>
              <Route exact="exact" path="/" component={Registration} />
              <Route exact="exact" path="/about" component={About} />
              <Route exact="exact" path="/login" component={Login} />
            </div>
          </HashRouter>
        </div>
      </div>
    );
  }
}
export class Login extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      email: "",
      password: "",
      error: false
    };
    this.handleInput = this.handleInput.bind(this);
    this.login = this.login.bind(this);
  }
  handleInput(e) {
    this.setState({
      [e.target.name]: e.target.value
    });
  }
  login(e) {
    axios
      .post("/login", {
        email: this.state.email,
        password: this.state.password
      })
      .then(result => {
        console.log("RESSUUUULLLTTT REGISTER AXIOS:", result);
        console.log("RESULT.DATA :", result.data);
        console.log("RESULT.DATA.SUCESS:", result.data.success);
        if (result.data.success) {
          location.replace("/");
        } else {
          this.setState({ error: true });
        }
      });
  }
  render() {
    var currentLocation = location.hash;

    console.log("****login*", currentLocation);
    return (
      <div className="registration">
        <div className="blackBox">
          {currentLocation != "#/about" && (
            <div>
              <img id="linkImg" src="/link.png" />
              <Link id="about" to="/about">
                ABOUT
              </Link>
            </div>
          )}

          {this.state.error && <div className="error">ERROR TRY AGAIN!</div>}
          <p>LOGIN:</p>
          <input
            onChange={this.handleInput}
            type="email"
            placeholder="EMAIL"
            name="email"
          />
          <br />
          <input
            onChange={this.handleInput}
            placeholder="PASSWORD"
            type="password"
            name="password"
          />
          <br />
          <button className="button" onClick={this.login}>
            LOGIN
          </button>
        </div>
        <p>
          You are not a member yet?
          <Link to="/"> Click here to Sign up!</Link>
        </p>
      </div>
    );
  }
}
export class Registration extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      first: "",
      last: "",
      email: "",
      password: "",
      error: false,
      correctMail: true,
      okPassword: true,
      okFirst: true,
      okLast: true
    };
    this.handleInput = this.handleInput.bind(this);
    this.register = this.register.bind(this);
    this.validateEmail = this.validateEmail.bind(this);
    this.validatePassword = this.validatePassword.bind(this);
    // this.checkLengthFirstname = this.checkLengthFirstname.bind(this);
    // this.checkLengthLastname = this.checkLengthLastname.bind(this);
  }
  handleInput(e) {
    this.setState(
      {
        [e.target.name]: e.target.value
      },
      () => {
        this.validateEmail();
        this.validatePassword();
        // this.checkLengthFirstname();
        // this.checkLengthLastname();
      }
    );
  }
  // checkLengthFirstname() {
  //   if (this.state.first.length == 0) {
  //     this.setState({
  //       okFirst: false
  //     });
  //   } else {
  //     this.setState({
  //       okFirst: true
  //     });
  //   }
  // }
  // checkLengthLastname() {
  //   if (this.state.last.length == 0) {
  //     this.setState({
  //       okLast: false
  //     });
  //   } else {
  //     this.setState({
  //       okLast: true
  //     });
  //   }
  // }
  validatePassword() {
    if (this.state.password.length == 0) {
      return;
    }
    if (this.state.password.length < 6) {
      this.setState({ okPassword: false });
    } else {
      this.setState({ okPassword: true });
    }
  }
  validateEmail() {
    if (this.state.email.length == 0) {
      return;
    }
    const mailformat = /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/;
    if (this.state.email.match(mailformat)) {
      this.setState({ correctMail: true });
    } else {
      this.setState({ correctMail: false });
    }
  }
  register(e) {
    axios
      .post("/register", {
        first: this.state.first,
        last: this.state.last,
        email: this.state.email,
        password: this.state.password
      })
      .then(result => {
        console.log("RESSUUUULLLTTT REGISTER AXIOS:", result);
        console.log("RESULT.DATA :", result.data);
        console.log("RESULT.DATA.SUCESS:", result.data.success);
        if (result.data.success) {
          location.replace("/");
        } else {
          this.setState({ error: true });
        }
      });
  }
  render() {
    var currentLocation = location.hash;
    console.log("****registration*", currentLocation);
    return (
      <div className="registration">
        {currentLocation != "#/about" && (
          <div>
            <img id="linkImg" src="/link.png" />
            <Link id="about" to="/about">
              ABOUT
            </Link>
          </div>
        )}
        <div className="blackBox">
          {this.state.error && <div className="error">ERROR TRY AGAIN!</div>}
          <p>REGISTER:</p>
          <input
            // className={this.state.okFirst == false ? "incorrectFirst" : ""}
            onChange={this.handleInput}
            placeholder="FIRSTNAME"
            name="first"
          />
          <br />
          <input
            // className={this.state.okLast == false ? "incorrectLast" : ""}
            onChange={this.handleInput}
            placeholder="LASTNAME"
            name="last"
          />
          <br />
          <input
            className={this.state.correctMail == false ? "incorrectEmail" : ""}
            onChange={this.handleInput}
            type="email"
            placeholder="EMAIL"
            name="email"
          />
          <br />
          <input
            className={
              this.state.okPassword == false ? "incorrectPassword" : ""
            }
            onChange={this.handleInput}
            placeholder="PASSWORD"
            type="password"
            name="password"
          />
          <br />
          <button className="button" onClick={this.register}>
            SIGN UP
          </button>
        </div>
        <p>
          You are already a member?
          <Link to="/login"> Click here to Log in!</Link>
        </p>
      </div>
    );
  }
}
