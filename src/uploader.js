import React from "react";
import axios from "./axios";

export class Uploader extends React.Component {
  constructor(props) {
    super(props);
    console.log("PROPS:", props);

    this.uploadImage = this.uploadImage.bind(this);
  }

  uploadImage(e) {
    console.log("CLICKED UPLOADIMAGE");

    var file = e.target.files[0];

    var formData = new FormData();
    formData.append("file", file);

    axios
      .post("/upload", formData)
      .then(response => {
        console.log("URL in AXIOS POST:", response.data.result);
        console.log("THIS.PROPS****", this.props);
        this.props.setImage(response.data.result);
        // this.setImage(response.data.result);
      })
      .catch(function(err) {
        console.log("ERROR IN UPLOAD :", err.message);
      });
  }

  render() {
    return (
      <div className="uploadImageModal">
        <h1>
          {this.props.first.toUpperCase()} DO YOU WANT TO CHANGE YOUR PROFILE
          IMAGE?{" "}
        </h1>

        <p>Click here to upload your new face.</p>

        <label htmlFor="file">IMAGE UPLOAD</label>
        <input
          id="file"
          type="file"
          accept="image/*"
          name="file"
          onChange={this.uploadImage}
        />
      </div>
    );
  }
}
