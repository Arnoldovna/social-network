import React from "react";
import axios from "./axios";
import { App } from "./app.js";
import { FriendButton } from "./friendButton.js";
import { Link } from "react-router-dom";
import Wall from "./wall.js";

export class OtherProfile extends React.Component {
  constructor() {
    super();
    this.state = {
      notFound: false
    };
  }

  componentDidMount() {
    console.log("ComponentDidMount OtherProfile");
    const opp = this.props.match.params.id;

    if (opp == this.props.currentUserId) {
      this.props.history.push("/");
    } else {
      axios
        .get("/profile/" + opp)
        .then(result => {
          this.setState({
            otherBio: result.data.result.usersbio,
            otherFirst: result.data.result.first,
            otherLast: result.data.result.last,
            otherImageurl: result.data.result.imageurl
          });
        })
        .catch(err => {
          if (!this.state.otherBio) {
            console.log("this.state.otherBio", this.state.otherBio);
            this.setState({ notFound: true });
            console.log("err in AXIOS OTHER PROILE: ", err.message);
          }
        });
    }
  }

  render() {
    console.log("this.props:", this.props);
    const bio = this.stateBio || "No Bio Added";
    const image = this.state.otherImageurl || "/noun_profile_1103174.png";
    return (
      <div className="flex-container">
        {this.state.notFound ? (
          <div>
            {/* {!this.state.currentUserId && <MyProfile />} */}
            <h1>NO USER FOUND!</h1>
          </div>
        ) : (
          <div className="profile-container">
            {/* {!this.state.currentUserId && <MyProfile />} */}
            <img className="otherProfile" src={image} />
            <p className="name">
              {this.state.otherFirst} {this.state.otherLast}
            </p>
            <p className="bio"> {bio}</p>
            <FriendButton otherProfileId={this.props.match.params.id} />
          </div>
        )}
        <Wall otherProfileId={this.props.match.params.id} />
      </div>
    );
  }
}

export function MyProfile() {
  return (
    <div>
      <Link to="/">My Profile</Link>
    </div>
  );
}

// render() {
//
//     console.log("this.props *:", this.props);
//     const bio = this.stateBio || "No Bio Added";
//     const image = this.state.otherImageurl || "/noun_profile_1103174.png";
//
//     if ({ this.state.notFound }) {
//         return (
//             <div>
//             <h1>NO USER FOUND!</h1>
//             </div>
//         )
//     } else {
//         return (
//         <div>
//             <img className="otherProfile" src={image}/>
//             <p>NAME: {this.state.otherFirst} {this.state.otherLast}</p>
//             <p>BIO: {bio}</p>
//         </div>
//     )
//
//     }
// }
