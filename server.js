const express = require("express");
const app = express();

const donateItems = {
  users: {
    "145772": {
      items: [
        {
          id: 123456789,
          name: "10 Robux",
          price: 10,
          assetType: "Gamepass"
        }
      ]
    }
  }
};

app.get("/", (req, res) => {
  res.send("MAINTIPS is running");
});

app.get("/donate_items.json", (req, res) => {
  res.json(donateItems);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server running on port " + port);
});
