import React from "react";
import axios from "./axios";
import { connect } from "react-redux";
import {
  showPosts,
  uploadPost,
  receiveFriendsAndWanabees,
  deletePost
} from "./actions";
import { initSocket } from "./socket.js";

class Wall extends React.Component {
  constructor() {
    super();
    this.sendMessage = this.sendMessage.bind(this);
    this.deletePost = this.deletePost.bind(this);
  }

  componentDidMount() {
    console.log("Wall componentDidMount!");
    let socket = initSocket();
    // console.log("this.props.id // access to my posts", this.props.id);
    // console.log(
    //   " this.props.otherProfileId // access to posts of my friend",
    //   this.props.otherProfileId
    // );

    if (this.props.id) {
      socket.emit("allPosts", this.props.id);
    } else if (this.props.otherProfileId) {
      socket.emit("allPosts", this.props.otherProfileId);
    }

    !this.props.posts && this.props.dispatch(receiveFriendsAndWanabees());
  }

  deletePost(id) {
    let socket = initSocket();
    console.log("this.PostId", id);
    socket.emit("deletePost", id);
  }

  componentDidUpdate() {
    console.log("Here in component DID UPDATE");

    if (document.querySelector("#textarea")) {
      document.querySelector("#textarea").value = "";
    }
  }

  sendMessage(e) {
    let socket = initSocket();
    // console.log("this.props.id !!!! access to my posts", this.props.id);
    // console.log(
    //   " this.props.otherProfileId !!!!! access to posts of my friend",
    //   this.props.otherProfileId
    // );
    let message = this.currentMessage;

    if (e.type == "click") {
      if (this.props.id) {
        socket.emit("newPost", {
          profileId: this.props.id,
          message
        });
      } else if (this.props.otherProfileId) {
        socket.emit("newPost", {
          profileId: this.props.otherProfileId,
          message
        });
      }
    }
  }

  render() {
    const { posts, friendsOrWanabees, alreadyFriends } = this.props;

    const yesItsMyFriend =
      alreadyFriends &&
      alreadyFriends.filter(friend => {
        return friend.id == this.props.otherProfileId;
      }).length;

    const ItsMyPage = this.props.id;
    // console.log("+++++++++++++++++++ItsMyPage?", !!ItsMyPage);

    var renderInput;
    if (!!ItsMyPage || !!yesItsMyFriend) {
      renderInput = (
        <div className="postInput">
          <textarea
            id="textarea"
            onChange={e => (this.currentMessage = e.target.value)}
          />
          <button onClick={this.sendMessage}>SEND</button>
        </div>
      );
    }
    // console.log("rrrrrrr", renderInput);

    const renderWall = posts && (
      <div className="wall">
        <div className="post-container">
          {posts.map(post => (
            <div key={post.id} className="friend">
              {!post.imageurl ? (
                <img className="friendsImg" src="/noun_profile_1103174.png" />
              ) : (
                <img className="friendsImg" src={post.imageurl} />
              )}
              <img className="friendsImg" src={post.feed_imageurl} />
              <p>{post.feed_text}</p>
              <p className="post-created_at">{post.created_at}</p>
              <button
                className="button"
                onClick={e => this.deletePost(post.id)}
              >
                DELETE POST
              </button>
            </div>
          ))}
        </div>
      </div>
    );

    return (
      <div id="feed">
        {!!renderInput ? renderInput : <p />}
        {!posts || (!posts.length && <h1>No Posts!</h1>)}
        {!!posts && !!posts.length && renderWall}
      </div>
    );
  } /* last brackets from  render */
} /*last brackets from component*/

function mapStateToProps(state) {
  // console.log("asdfjklöasdfjklöasdfjkö", this.props.otherProfileId);
  return {
    posts: state.posts,
    friendsOrWanabees: state.friendsOrWanabees,
    alreadyFriends:
      state.friendsOrWanabees &&
      state.friendsOrWanabees.filter(fw => fw.accepted)
  };
}

export default connect(mapStateToProps)(Wall);
