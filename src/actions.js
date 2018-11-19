import axios from "./axios";

console.log("/ACTIONS.JS RUNNING!");

export async function receiveFriendsAndWanabees() {
  const { data } = await axios.get("/friendsOrWanabees");
  return {
    type: "RECEIVE_FRIENDS_AND_WANNANES",
    friendsOrWanabees: data.data
  };
}

export async function acceptRequest(otherProfileId) {
  const { data } = await axios.post("/acceptFriendship/" + otherProfileId);
  return {
    type: "ACCEPT_REQUEST",
    otherProfileId
  };
}

export async function endFriendship(otherProfileId) {
  const { data } = await axios.post("/endFriendship/" + otherProfileId);
  return {
    type: "END_FRIENDSHIP",
    otherProfileId
  };
}

export function onlineUsers(onlineUsers) {
  // console.log("onlineUsers action fired:", onlineUsers);
  return {
    type: "ONLINEUSERS",
    onlineUsers
  };
}

export function userJoined(userJoined) {
  // console.log("userJoined action fired:", userJoined);
  return {
    type: "USERJOINED",
    userJoined
  };
}

export function userLeft(userLeft) {
  // console.log("userleft action fired:", userLeft);
  return {
    type: "USERLEFT",
    userLeft
  };
}

export function showChat(allMessages) {
  // console.log("showChat action fired****:", allMessages);
  return {
    type: "SHOW_CHAT",
    allMessages
  };
}

export function uploadMessage(newMessage) {
  // console.log("uploadMessage action fired****:", newMessage);
  return {
    type: "UPLOAD_MESSAGE",
    newMessage
  };
}

export function showPosts(allPosts) {
  console.log("showPosts action fired****:", allPosts);
  return {
    type: "SHOW_POSTS",
    allPosts
  };
}

export function uploadPost(newPost) {
  console.log("uploadPost action fired****:", newPost);
  return {
    type: "UPLOAD_POST",
    newPost
  };
}

export function deletePost(postId) {
  console.log("uploadPost action fired****:", postId);
  return {
    type: "DELETE_POST",
    postId
  };
}

export function searchUser(userData) {
  console.log("searchUser action fired****:", userData);
  return {
    type: "SEARCH_USER",
    userData
  };
}
