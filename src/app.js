import React from "react";
import axios from "./axios";
import { Uploader } from "./uploader.js";
import { Profile } from "./profile.js";
import { BrowserRouter, Route, Link } from "react-router-dom";
import { OtherProfile } from "./otherProfile.js";
import { FriendButton } from "./friendButton.js";
import Friends from "./friends.js";
import OnlineUsers from "./onlineUsers.js";
import Chat from "./chat.js";
import Search from "./search.js";

//container components
export class App extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      uploaderIsVsible: false,
      imageurl: "",
      first: "",
      last: "",
      id: "",
      usersbio: ""
    };
    this.showUploader = this.showUploader.bind(this);
    this.setImage = this.setImage.bind(this);
    this.setBio = this.setBio.bind(this);
  }

  componentDidMount() {
    console.log("componentDidMount App");

    axios.get("/users").then(({ data }) => {
      // console.log("DATA.FIRST:", data.data.first);
      this.setState({
        imageurl: data.data.imageurl,
        first: data.data.first,
        last: data.data.last,
        id: data.data.id,
        usersbio: data.data.usersbio
      });
    });
  }

  showUploader() {
    console.log("showUploader");
    this.setState({
      uploaderIsVisible: true
    });
  }

  setImage(imageurl) {
    this.setState({
      imageurl: imageurl,
      uploaderIsVisible: false
    });
  }

  setBio(usersbio) {
    this.setState({
      usersbio: usersbio
    });
  }

  render() {
    if (!this.state.id) {
      return null;
    }

    return (
      <div>
        <div className="header">
          <Logo />

          <div id="menu-now">
            <a classname="link" href="/">
              HOME
            </a>
            <br />
            <a classname="link" href="/chat">
              CHAT
            </a>
            <br />
            <a classname="link" href="/online">
              ONLINE
            </a>{" "}
            <br />
            <a classname="link" href="/friends">
              FRIENDS
            </a>
            <Logout />
          </div>

          <p className="menu">MENU</p>
          <ProfilePic
            imageurl={this.state.imageurl}
            first={this.state.first}
            last={this.state.last}
            id={this.state.id}
            clickHandler={this.showUploader}
          />
        </div>

        <Search />

        <BrowserRouter>
          <div>
            <Route
              exact
              path="/"
              render={props => (
                <Profile
                  first={this.state.first}
                  last={this.state.last}
                  id={this.state.id}
                  usersbio={this.state.usersbio}
                  imageurl={this.state.imageurl}
                  setBio={this.setBio}
                  clickHandler={this.showUploader}
                />
              )}
            />

            <Route
              exact
              path="/users/:id"
              render={props => (
                <OtherProfile
                  {...props}
                  currentUserId={this.state.id}
                  key={props.match.url}
                />
              )}
            />

            <Route exact path="/friends" component={Friends} />
            <Route exact path="/online" component={OnlineUsers} />
            <Route exact path="/chat" component={Chat} />
          </div>
        </BrowserRouter>

        {this.state.uploaderIsVisible && (
          <Uploader first={this.state.first} setImage={this.setImage} />
        )}
      </div>
    );
  }
}

//presentational componenet
export function ProfilePic(props) {
  const image = props.imageurl || "/noun_profile_1103174.png";
  // console.log("ProfilePic", props.clickHandler);
  return (
    <div>
      <img className="profilePic" onClick={props.clickHandler} src={image} />
    </div>
  );
}

export function Logo() {
  return (
    <div>
      <img className="smallSmiley" src="/happy.png" />
    </div>
  );
}

export function Logout() {
  return (
    <div className="logout">
      {/* <img id="logoutImg" src="/link.png" /> */}
      <a href="/logout">LOG OUT</a>
    </div>
  );
}

//ipmort friendscomponenet from friends.js
// add a route for the friends Componenet
// >Route path="/friends" componenet=(Friends) />
