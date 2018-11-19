import React from "react";
import { connect } from "react-redux";
import { showChat } from "./actions";
import { initSocket } from "./socket.js";

class Chat extends React.Component {
  constructor() {
    super();

    this.sendMessage = this.sendMessage.bind(this);
  }

  componentDidMount() {
    !this.props.allMessages && this.props.dispatch(showChat());
    console.log("Chat componentDidMount!");
  }
  componentDidUpdate() {
    console.log("Here in component DID UPDATE");
    // console.log("this.chatContainer:", this.chatContainer);
    this.chatContainer.scrollTop =
      this.chatContainer.scrollHeight - this.chatContainer.clientHeight;

    document.querySelector("#textarea").value = "";
  }

  sendMessage(e) {
    let socket = initSocket();
    // console.log("++++++:", this.currentMessage, e.type);
    let message = this.currentMessage;
    // console.log("message***", message);
    // console.log(e.which);
    if (e.type == "click") {
      // console.log("HEEEE*******************************2");
      // console.log("message***2*:", message);
      let message = this.currentMessage;
      socket.emit("newMessage", message);
    }
  }

  render() {
    const { allMessages } = this.props;
    if (!allMessages) {
      return null;
    }

    const renderChat = (
      <div>
        <div
          className="chat-messages-container"
          ref={elem => (this.chatContainer = elem)}
        >
          {this.props.allMessages.map(message => (
            <div key={message.id} className="singlePost">
              {!message.imageurl ? (
                <img className="chatImg" src="/noun_profile_1103174.png" />
              ) : (
                <img className="chatImg" src={message.imageurl} />
              )}

              <div>
                <p className="message">{message.chat_message}</p>
                <p className="date">{message.created_at}</p>
              </div>
            </div>
          ))}
        </div>
        <textarea
          id="textarea"
          onChange={e => (this.currentMessage = e.target.value)}
        />
        <br />
        <button className="button" onClick={this.sendMessage}>
          SEND
        </button>
      </div>
    );

    return (
      <div>
        {!allMessages.length && <h1>Start typing :)...</h1>}
        {!!allMessages.length && renderChat}
      </div>
    );
  }
}

const mapStateToProps = state => {
  // console.log("STATE***in chat.js:", state);
  return {
    allMessages: state.allMessages
  };
};

export default connect(mapStateToProps)(Chat);
