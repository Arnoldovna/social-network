import React from "react";
import axios from "./axios";
import { App, ProfilePic } from "./app.js";
import { Bio } from "./bio.js";
import Wall from "./wall.js";

//appwill give details about the user and will pass it to profile component
export class Profile extends React.Component {
  constructor(props) {
    super(props);
  }

  render() {
    console.log(this.props);
    return (
      <div className="flex-container">
        <div className="profile-container">
          <ProfilePic
            className="profile"
            first={this.props.first}
            last={this.props.last}
            id={this.props.id}
            usersbio={this.props.usersbio}
            imageurl={this.props.imageurl}
            clickHandler={this.props.clickHandler}
          />
          <p className="name">
            {this.props.first} {this.props.last}
          </p>

          <Bio usersbio={this.props.usersbio} setBio={this.props.setBio} />
        </div>

        <div>
          <Wall id={this.props.id} />
        </div>
      </div>
    );
  }
}
