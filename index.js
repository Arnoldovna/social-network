const express = require("express");
const app = express();
const db = require("./db");
const compression = require("compression");
const s3 = require("./s3.js");
const { s3Url } = require("./config.json");
var multer = require("multer");
var uidSafe = require("uid-safe");
var path = require("path");
const csurf = require("csurf");
var cookieSession = require("cookie-session");
const server = require("http").Server(app);
const io = require("socket.io")(server, { origins: "localhost:8080" });

var diskStorage = multer.diskStorage({
  destination: function(req, file, callback) {
    callback(null, __dirname + "/uploads");
  },
  filename: function(req, file, callback) {
    uidSafe(24).then(function(uid) {
      callback(null, uid + path.extname(file.originalname));
    });
  }
});

var uploader = multer({
  storage: diskStorage,
  limits: {
    fileSize: 2097152
  }
});

app.use(compression());

const cookieSessionMiddleware = cookieSession({
  secret: `I'm always angry.`,
  maxAge: 1000 * 60 * 60 * 24 * 90
});

app.use(cookieSessionMiddleware);
io.use(function(socket, next) {
  cookieSessionMiddleware(socket.request, socket.request.res, next);
});

app.use(require("body-parser").json());

app.use(csurf());

app.use(function(req, res, next) {
  res.cookie("mytoken", req.csrfToken());
  next();
});

if (process.env.NODE_ENV != "production") {
  app.use(
    "/bundle.js",
    require("http-proxy-middleware")({
      target: "http://localhost:8081/"
    })
  );
} else {
  app.use("/bundle.js", (req, res) => res.sendFile(`${__dirname}/bundle.js`));
}

app.use(express.static("./public"));

app.post("/register", function(req, res) {
  db.hashPassword(req.body.password)
    .then(hash => {
      return db.insertNewUser(
        req.body.first,
        req.body.last,
        req.body.email,
        hash
      );
    })
    .then(result => {
      // console.log("RESULT VON REGISTER :", result["rows"][0]);
      // console.log("req.session.userID:", result["rows"][0].id);
      req.session.userID = result["rows"][0].id;
      res.json({ success: true });
    })
    .catch(err => {
      console.log("err in /register POST: ", err.message);
      res.json({ success: false });
    });
});

app.post("/usersbio", function(req, res) {
  // console.log("req.body", req.body);
  db.uploadBio(req.body.usersbio, req.session.userID)
    .then(result => {
      console.log(result);
      res.json({ result });
    })
    .catch(err => {
      console.log("err in getUsersBio: ", err.message);
      res.json({});
    });
});

app.get("/profile/:id", function(req, res) {
  // console.log("req.params.id: ", req.params.id);
  return db
    .getDataById(req.params.id)
    .then(result => {
      res.json({ result });
    })
    .catch(err => {
      console.log("err in PROFILE/:ID GET: ", err.message);
      res.json({});
    });
});

app.get("/status/:otherProfileId", function(req, res) {
  // console.log("req.params.otherProfileId", req.params.otherProfileId);

  return db
    .getStatus(req.session.userID, req.params.otherProfileId)
    .then(result => {
      // console.log("RESULT IN GET STATUS INDEX******", result);
      if (result) {
        if (result.accepted) {
          res.json({ textInsideButton: "End Friendship" });
        } else if (!result.accepted) {
          if (result.sender_id == req.session.userID) {
            res.json({ textInsideButton: "Cancel Friend Request" });
          } else if (result.receiver_id == req.session.userID) {
            res.json({ textInsideButton: "Accept Friend Request" });
          }
        }
      } else if (!result) {
        // console.log("MAKE FRIEND REQUEST");
        res.json({ textInsideButton: "Make Friend Request" });
      }
    });
});

app.post("/makeRequest/:otherProfileId", function(req, res) {
  return db
    .makeRequest(req.session.userID, req.params.otherProfileId)
    .then(result => {
      if (req.session.userId == result.sender_id) {
        res.json({ textInsideButton: "Cancel Friend Request" });
      }
    });
});

app.post("/cancelRequest/:otherProfileId", function(req, res) {
  return db
    .cancelRequest(req.session.userID, req.params.otherProfileId)
    .then(result => {
      if (result) {
        // console.log("RESULT IN POST CANCEL INDEX", result);
        res.json({ textInsideButton: "Make Friend Request" });
      }
    })
    .catch(err => {
      console.log("err in /cancelRequest POST: ", err.message);
    });
});

app.post("/acceptFriendship/:otherProfileId", function(req, res) {
  return db
    .acceptFriendship(req.session.userID, req.params.otherProfileId)
    .then(result => {
      // console.log("RESULT IN POST ACCEPTFRIENDSHIP INDEX", result);
      res.json({ result, textInsideButton: "End Friendship" });
    })
    .catch(err => {
      console.log("err in /acceptFriendship POST: ", err.message);
    });
});

app.post("/endFriendship/:otherProfileId", function(req, res) {
  return db
    .endFriendship(req.session.userID, req.params.otherProfileId)
    .then(result => {
      // console.log("RESULT IN POST EndFRIENDSHIP INDEX", result);
      res.json({ result, textInsideButton: "Make Friend Request" });
    })
    .catch(err => {
      console.log("err in /endFriendship POST: ", err.message);
    });
});

app.get("/friendsOrWanabees", function(req, res) {
  return db.getFriendsOrWanabees(req.session.userID).then(data => {
    // console.log("GET FRIENDS OR WANABEES RSULT INDEX:", data);
    res.json({ data });
  });
});

app.post("/login", function(req, res) {
  db.dbPassword(req.body.email)
    .then(hash => {
      return db.checkPassword(req.body.password, hash);
    })
    .then(answer => {
      if (answer) {
        console.log("SUCESSFUL PASSWORD MATCH:", answer);
        db.getUserId(req.body.email).then(result => {
          req.session.userID = result;
          // console.log("SESSION.USERID:", req.session.userID);
          res.json({ success: true });
        });
      } else {
        console.log("NOT SUCESSFUL");
        res.json({ success: false });
      }
    })
    .catch(err => {
      console.log("err in /login POST: ", err.message);
      res.json({ success: false });
    });
});

app.post("/upload", uploader.single("file"), s3.upload, function(req, res) {
  const imgUrl = s3Url + req.file.filename;
  console.log("imageurl", imgUrl);
  // If nothing went wrong the file is already in the uploads directory
  if (req.file) {
    return db.uploadImage(imgUrl, req.session.userID).then(result => {
      // console.log("**U*****************AMAZON*RESULT:", result);
      res.json({ result });
    });
  } else {
    res.json({});
  }
});

app.get("/users", function(req, res) {
  return db
    .getDataById(req.session.userID)
    .then(data => {
      // console.log("ALL DATA OF LOGEDIN PERSON:", data);
      res.json({ data });
    })
    .catch(err => {
      console.log("err in get /users: ", err.message);
    });
});

app.get("/logout", function(req, res) {
  req.session = null;
  // console.log("REQ.SESSION:", req.session);
  res.redirect("/");
});

app.get("/welcome", function(req, res) {
  if (req.session.userID) {
    res.redirect("/");
  } else {
    res.sendFile(__dirname + "/index.html");
  }
});

//_______________* SHOULD ALWAYS STAY AT THE END_________________________
app.get("*", function(req, res) {
  if (!req.session.userID) {
    res.redirect("/welcome");
  } else {
    res.sendFile(__dirname + "/index.html");
  }
});

server.listen(8080, function() {
  console.log("I'm listening.");
});

//------------------------------server-side socket code-------------------------------

let onlineUsers = [];

io.on("connection", function(socket) {
  console.log(`socket with the id ${socket.id} is now connected`);
  //socket.request.session.userID
  console.log("socket.request.session", socket.request.session);

  //------------------------GET ALL POSTS------------------------------

  socket.on("allPosts", profileId => {
    console.log("HEEEEEEREE");

    return db
      .showWallPosts(profileId)
      .then(result => {
        // console.log("SHOW WALL POSTS:", result);

        io.sockets.emit("allPosts", result.reverse());
      })
      .catch(err => {
        console.log("err in allPosts ", err.message);
        return;
      });
  });

  //list of everyone who's currently online
  onlineUsers.push({
    userID: socket.request.session.userID,
    socketID: socket.id
  });

  let onlineUsers1 = onlineUsers.reduce(
    (x, y) => (x.findIndex(a => a.userID == y.userID) < 0 ? [...x, y] : x),
    []
  );
  // console.log("onlineUsers filtered:", onlineUsers1);

  // console.log("onlineUsers:", onlineUsers);

  let IDsUnfiltered = onlineUsers.map(user => {
    return user.userID;
  });

  var IDs = IDsUnfiltered.reduce((a, b) => {
    if (a.indexOf(b) < 0) a.push(b);
    return a;
  }, []);

  console.log("IDs:", IDs);

  //------------------------------ GET ONLINE USERS------------------------
  db.getUsersByIDs(IDs)
    .then(result => {
      // console.log("results from getUsersByIDs:", result.rows);
      socket.emit(
        "onlineUsers",
        result.rows
      ); /*sending data to front end with emit*/
    })
    .catch(err => {
      console.log("err in get socket onlineUsers INDEx.js ", err.message);
    });

  //----------------------USER JOIN---------------------------------

  const count = onlineUsers.filter(
    user => user.userID == socket.request.session.userID
  ).length;
  if (count == 1) {
    db.getDataById(socket.request.session.userID)
      .then(result => {
        // console.log("result from getDataByID****:", result);
        socket.broadcast.emit("userJoined", result);
      })
      .catch(err => {
        console.log("err in get socket Userjoined INDEx.js ", err.message);
      });
  } else {
    console.log("MORE THAN ONE");
  }

  //---------------------ON DISCONNECT--------------------
  socket.on("disconnect", () => {
    // console.log(`socket with the id ${socket.id} is now disconnected`);
    db.getDataById(socket.request.session.userID)
      .then(result => {
        let indexOfUserID = IDs.indexOf(socket.request.session.userID);
        if (indexOfUserID > -1) {
          onlineUsers.splice(indexOfUserID, 1);
          // console.log("result from getDataByID***disconnect*:", result);
          io.sockets.emit("userLeft", result);
        }
      })
      .catch(err => {
        console.log("err in get disconnect ", err.message);
        return;
      });
  });

  //---------------------UPLOAD NEW MESSAGE----------------------
  socket.on("newMessage", function(inputText) {
    console.log("newMessage:", inputText);
    return db
      .saveChatMessage(socket.request.session.userID, inputText)
      .then(data => {
        // console.log("the sender_id:", data.rows[0].sender_id);
        return db.getDataById(data.rows[0].sender_id);
      })
      .then(result => {
        // console.log("**111111111111**", result);

        let newMessageObj = {
          first: result.first,
          last: result.last,
          imageurl: result.imageurl,
          chat_message: inputText,
          created_at: new Date()
        };
        // console.log("****new Message Object", newMessageObj);

        io.sockets.emit("newMessage", newMessageObj);
      })
      .catch(err => {
        console.log("err in newMessage ", err.message);
        return;
      });
  });

  //------------------------UPLOAD POST------------------------------

  socket.on("newPost", ({ profileId, message }) => {
    return db
      .uploadPost(profileId, socket.request.session.userID, message)
      .then(result => {
        // var created_at = result.rows[0].created_at;
        return db.getDataById(result.rows[0].sender_id);
      })
      .then(result => {
        // console.log("RESULT NEW POST SENDER", result);
        // console.log("created_at", created_at);

        let newPostsObj = {
          id: result.id,
          first: result.first,
          last: result.last,
          imageurl: result.imageurl,
          feed_text: message,
          created_at: new Date()
        };
        // console.log("newPostsObj******", newPostsObj);
        io.sockets.emit("newPost", newPostsObj);
      })
      .catch(err => {
        console.log("err in newPost ", err.message);
        return;
      });
  });

  //----------------------DELETE POST---------------------------------

  socket.on("deletePost", postId => {
    return db
      .deletePost(postId)
      .then(theSamePostId => {
        // console.log("RESULT NEW POST SENDER", theSamePostId);

        io.sockets.emit("deletePost", theSamePostId);
      })
      .catch(err => {
        console.log("err in deletePost ", err.message);
        return;
      });
  });

  //---------------------GET TEN MESSAGES-------------------------
  db.showLastTenMessages()
    .then(allMessages => {
      // console.log("allMessages:", allMessages);
      io.sockets.emit("showChat", allMessages.reverse());
    })
    .catch(err => {
      console.log("err in showChat ", err.message);
      return;
    });

  //------------------------SEARCH USER----------------------------
  socket.on("searchUser", searchInput => {
    console.log("searchInput:", searchInput.searchInput);
    return db.searchUser(searchInput.searchInput).then(searchResult => {
      console.log("searchResult", searchResult);
      socket.emit("searchUser", searchResult);
    });
  });

  //------------------------LAST BRACKETS------------------------------
});
