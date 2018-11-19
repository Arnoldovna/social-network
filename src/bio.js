import React from "react";
import axios from "./axios";

import { App, ProfilePic } from "./app.js";

export class Bio extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      mode: "",
      draftBio: ""
    };
    this.uploadBio = this.uploadBio.bind(this);
    this.handleBioInput = this.handleBioInput.bind(this);
    this.edit = this.edit.bind(this);
    this.cancel = this.cancel.bind(this);
  }

  handleBioInput(e) {
    this.setState({
      draftBio: e.target.value
    });
  }

  uploadBio() {
    axios
      .post("/usersbio", {
        usersbio: this.state.draftBio
      })
      .then(response => {
        console.log("RESULT IN UPLOADBIO:", response.data.result);
        this.props.setBio(response.data.result);
        this.cancel();
      });
  }
  edit() {
    this.setState({
      mode: "edit"
    });
  }

  cancel() {
    this.setState({
      mode: ""
    });
  }

  render() {
    if (this.state.mode == "edit") {
      console.log("this props:", this.props);
      return (
        <div>
          <textarea
            className="bioInput"
            defaultValue={this.props.usersbio}
            onChange={this.handleBioInput}
          />
          <button className="button abstand" onClick={this.uploadBio}>
            SAVE
          </button>
          <button className="button abstand" onClick={this.cancel}>
            CANCEL
          </button>
        </div>
      );
    } else {
      return (
        <div>
          {!this.props.usersbio && <p>Click the edit button and add a bio.</p>}

          <p>{this.props.usersbio}</p>

          <button className="button abstand" onClick={this.edit}>
            EDIT
          </button>
        </div>
      );
    }
  }
}
