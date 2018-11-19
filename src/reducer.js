console.log("/reducer.js RUNNING!");

export default function(state = {}, action) {
  if (action.type == "RECEIVE_FRIENDS_AND_WANNANES") {
    state = {
      ...state,
      friendsOrWanabees: action.friendsOrWanabees
    };
  }
  // returns array with all accepted:true if id other other ist the same as action.id
  if (action.type == "ACCEPT_REQUEST") {
    state = {
      ...state,
      friendsOrWanabees: state.friendsOrWanabees.map(fw => {
        if (fw.id == action.otherProfileId) {
          return {
            ...fw,
            accepted: true
          };
        } else {
          return fw;
        }
      })
    };
  }

  // returns array with all accepted=true except the one with accepted=false

  if (action.type == "END_FRIENDSHIP") {
    console.log("action end friendship:", action);

    state = {
      ...state,
      friendsOrWanabees: state.friendsOrWanabees.filter(
        fw => fw.id != action.otherProfileId
      )
    };
  }

  if (action.type == "ONLINEUSERS") {
    state = {
      ...state,
      onlineUsers: action.onlineUsers
    };
  }

  // you can do also with slice and than push
  if (action.type == "USERJOINED") {
    state = {
      ...state,
      onlineUsers: [...state.onlineUsers, action.userJoined]
    };
  }

  if (action.type == "USERLEFT") {
    state = {
      ...state,
      onlineUsers: state.onlineUsers.filter(
        user => user.id != action.userLeft.id
      )
    };
  }

  if (action.type == "SHOW_CHAT") {
    state = {
      ...state,
      allMessages: action.allMessages
    };
  }

  if (action.type == "UPLOAD_MESSAGE") {
    state = {
      ...state,
      allMessages: [...state.allMessages, action.newMessage]
    };
  }

  if (action.type == "SHOW_POSTS") {
    state = {
      ...state,
      posts: action.allPosts
    };
  }

  if (action.type == "UPLOAD_POST") {
    console.log("HERE!!!!!!!!!!!");
    state = {
      ...state,
      posts: [action.newPost, ...state.posts]
    };
  }

  if (action.type == "DELETE_POST") {
    console.log("HERE!!!deletePost!!!!!!!!");
    state = {
      ...state,
      posts: state.posts.filter(post => post.id != action.postId)
    };
  }

  if (action.type == "SEARCH_USER") {
    console.log("HERE!!!  search User  !!!!!!!!", action.userData);
    state = {
      ...state,
      foundUsers: [action.userData]
    };
  }

  console.log("STATE****:", state);
  return state;
}
