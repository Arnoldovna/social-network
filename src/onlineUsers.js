import React from "react";
import { connect } from "react-redux";
import { onlineUsers } from "./actions";

export class OnlineUsers extends React.Component {
  constructor() {
    super();
  }

  componentDidMount() {
    console.log("onlineUsers componentDidMount!");
    !this.props.onlineUsers && this.props.dispatch(onlineUsers());
  }

  componentDidUpdate() {
    console.log("onlineUsers componentDidUpdate");
  }

  render() {
    const { onlineUsers } = this.props;
    if (!onlineUsers) {
      return null;
    }

    const renderOnlineUsers = (
      <div>
        <h1>ONLINE USERS:</h1>;
        {onlineUsers.map(user => (
          <div key={user.id} className="friend">
            {!user.imageurl ? (
              <img className="friendsImg" src="/noun_profile_1103174.png" />
            ) : (
              <img className="friendsImg" src={user.imageurl} />
            )}
            <p>
              {user.first.toUpperCase()} {user.last.toUpperCase()}
            </p>
          </div>
        ))}
      </div>
    );

    return (
      <div id="online">
        {!onlineUsers.length && <h1>Nobody Online!</h1>}
        {!!onlineUsers.length && renderOnlineUsers}
      </div>
    );
  }
}

function mapStateToProps(state) {
  return {
    onlineUsers: state.onlineUsers
  };
}

export default connect(mapStateToProps)(OnlineUsers);
