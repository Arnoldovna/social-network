import React from "react";
import { connect } from "react-redux";
import {
  receiveFriendsAndWanabees,
  endFriendship,
  acceptRequest
} from "./actions";
import { Link } from "react-router-dom";

class Friends extends React.Component {
  constructor() {
    super();
  }
  componentDidMount() {
    console.log("Friends componentDidMount!");
    !this.props.friendsOrWanabees &&
      this.props.dispatch(receiveFriendsAndWanabees());
  }

  render() {
    const {
      dispatch,
      alreadyFriends,
      wantToBeMyFriends,
      friendsOrWanabees
    } = this.props;
    if (!wantToBeMyFriends && !alreadyFriends) {
      return null;
    }

    const renderFriend = (
      <div>
        <div className="friends">
          <p>YOUR FRIENDS:</p>
          {alreadyFriends.map(fw => (
            <div key={fw.id} className="friend">
              {!fw.imageurl ? (
                <img className="friendsImg" src="/noun_profile_1103174.png" />
              ) : (
                <img className="friendsImg" src={fw.imageurl} />
              )}
              <p>
                {fw.first.toUpperCase()} {fw.last.toUpperCase()}
              </p>
              <button
                className="button"
                onClick={() => dispatch(endFriendship(fw.id))}
              >
                End Friendship
              </button>
            </div>
          ))}
        </div>

        <div className="friends">
          <p>FRIENDSHIP REQUESTS:</p>
          {this.props.wantToBeMyFriends.map(fw => (
            <div key={fw.id} className="friend">
              {!fw.imageurl ? (
                <img className="friendsImg" src="/noun_profile_1103174.png" />
              ) : (
                <img className="friendsImg" src={fw.imageurl} />
              )}
              <p>
                {fw.first.toUpperCase()} {fw.last.toUpperCase()}
              </p>
              <button
                className="button"
                onClick={() => dispatch(acceptRequest(fw.id))}
              >
                Accept Friend Request
              </button>
            </div>
          ))}
        </div>
      </div>
    );

    return (
      <div id="friend">
        {!friendsOrWanabees.length && <h1>No Friends!</h1>}
        {!!friendsOrWanabees.length && renderFriend}
      </div>
    );
  }
}

function mapStateToProps(state) {
  return {
    friendsOrWanabees: state.friendsOrWanabees,
    alreadyFriends:
      state.friendsOrWanabees &&
      state.friendsOrWanabees.filter(fw => fw.accepted),
    wantToBeMyFriends:
      state.friendsOrWanabees &&
      state.friendsOrWanabees.filter(fw => !fw.accepted)
  };
}

export default connect(mapStateToProps)(Friends);
