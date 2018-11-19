import * as io from "socket.io-client";
import {
  onlineUsers,
  userJoined,
  userLeft,
  showChat,
  uploadMessage,
  showPosts,
  uploadPost,
  deletePost,
  searchUser
} from "./actions.js";
let socket;

export function initSocket(store) {
  //if sentence helps to prevent sockets for one uer on multiple tabs

  if (!socket) {
    socket = io.connect();

    socket.on("onlineUsers", function(listOfUsers) {
      // console.log("listOfUsers:", listOfUsers);
      store.dispatch(onlineUsers(listOfUsers));
    });

    socket.on("userJoined", userWhoJoined => {
      // console.log("userWhoJoined:", userWhoJoined);
      store.dispatch(userJoined(userWhoJoined));
    });

    socket.on("userLeft", userWhoLeft => {
      // console.log("userWhoLeft:", userWhoLeft);
      store.dispatch(userLeft(userWhoLeft));
    });

    socket.on("newMessage", newMessage => {
      // console.log("new message:", newMessage);

      store.dispatch(uploadMessage(newMessage));
    });

    socket.on("showChat", allMessages => {
      // console.log("*****all Messages:****", allMessages);
      store.dispatch(showChat(allMessages));
    });

    socket.on("allPosts", allPostsArray => {
      console.log("*****all Posts:****", allPostsArray);
      store.dispatch(showPosts(allPostsArray));
    });

    socket.on("newPost", newPost => {
      console.log("new Post:", newPost);

      store.dispatch(uploadPost(newPost));
    });

    socket.on("deletePost", postId => {
      console.log("postId deletePost:", postId);

      store.dispatch(deletePost(postId));
    });

    socket.on("searchUser", userData => {
      console.log("userData:", userData);
      store.dispatch(searchUser(userData));
    });
  }
  return socket;
}
