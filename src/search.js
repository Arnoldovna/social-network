import React from "react";
import axios from "./axios";
import { connect } from "react-redux";
import { searchUser } from "./actions";
import { initSocket } from "./socket.js";

class Search extends React.Component {
  constructor() {
    super();
    this.submitSearch = this.submitSearch.bind(this);
  }

  componentDidMount() {
    console.log("Search componentDidMount!");
  }

  componentDidUpdate() {
    console.log("Search component DID UPDATE");
    if (document.querySelector(".input")) {
      document.querySelector(".input").value = "";
    }
  }

  submitSearch(e) {
    let socket = initSocket();
    let searchInput = this.currentSearch;
    if (e.type == "click") {
      socket.emit("searchUser", {
        searchInput
      });
    }
  }

  render() {
    const { foundUsers } = this.props;

    const renderSearch = (
      <div className="search">
        <input
          className="input"
          onChange={e => (this.currentSearch = e.target.value)}
        />
        <button onClick={this.submitSearch}>GO!</button>
      </div>
    );

    const renderModal = !!foundUsers && (
      <div className="search-modal">
        <p>DO YOU MEAN?</p>
        {foundUsers.map(user => (
          <div key={user.id} className="found">
            {!user.imageurl ? (
              <img className="foundImg" src="/noun_profile_1103174.png" />
            ) : (
              <img className="foundImg" src={user.imageurl} />
            )}

            <p>
              {user.first.toUpperCase()} {user.last.toUpperCase()}
            </p>
          </div>
        ))}
      </div>
    );

    return (
      <div id="search">
        {renderSearch}

        {!!foundUsers && renderModal}
      </div>
    );
  } /* last brackets from  render */
} /*last brackets from component*/

//--------------------------mapStateToProps---------------------

function mapStateToProps(state) {
  console.log("++++++++++++++++STATE+++++++++++:", state);
  return {
    foundUsers: state.foundUsers
  };
}

export default connect(mapStateToProps)(Search);
