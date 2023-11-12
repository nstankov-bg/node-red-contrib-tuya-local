const TuyaDev = require("tuyapi");
const {
  keyRename,
  getHumanTimeStamp,
  checkValidJSON,
  filterCommandByte,
} = require("./lib/utils");

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason, p) => {
  console.error("Unhandled Rejection:", reason);
});

module.exports = function (RED) {
  function TuyaNode(config) {
    try {
      RED.nodes.createNode(this, config);
      var node = this;
      var set_timeout = true;
      this.Name = config.devName;
      this.Id = config.devId;
      this.Key = config.devKey;
      this.Ip = config.devIp;
      this.version = config.protocolVer;
      this.renameSchema = config.renameSchema;
      this.filterCB = config.filterCB;
      const dev_info = { name: this.Name, ip: this.Ip, id: this.Id };
      const device = new TuyaDev({
        id: this.Id,
        key: this.Key,
        ip: this.Ip,
        version: this.version,
      });
      this.commandQueue = [];

      function connectToDevice(timeout, req) {
        try {
          device
            .find({ options: { timeout: timeout } })
            .then(() => {
              node.status({
                fill: "yellow",
                shape: "dot",
                text: "connecting",
              });
              node.log(req);
              device
                .connect()
                .then(() => {
                  node.status({
                    fill: "green",
                    shape: "dot",
                    text: "connected",
                  });
                })
                .catch((reason) => {
                  node.status({
                    fill: "red",
                    shape: "ring",
                    text: "failed: " + reason,
                  });
                });
            })
            .catch((error) => {
              node.status({
                fill: "red",
                shape: "ring",
                text: "device not found",
              });
              setTimeout(
                () => connectToDevice(timeout, "Retrying connection"),
                RETRY_DELAY
              );
            });
        } catch (error) {
          node.status({
            fill: "red",
            shape: "ring",
            text: `Error: ${error.message}`,
          });
        }
      }

      function disconnectDevice(deleted) {
        try {
          set_timeout = deleted ? false : true;
          device.disconnect();
        } catch (error) {
          node.status({
            fill: "red",
            shape: "ring",
            text: `Error: ${error.message}`,
          });
        }
      }

      async function wait(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
      }

      async function setDevice(req) {
        try {
          node.commandQueue.push(req);
          while (node.commandQueue.length > 0) {
            const currentReq = node.commandQueue.shift();
      
            if (currentReq == "request") {
              await device.get({ schema: true });
            } else if (currentReq == "connect") {
              connectToDevice(5, "Connection requested by input for device: " + node.Name);
            } else if (currentReq == "disconnect") {
              device.disconnect();
            } else if (currentReq == "toggle") {
              await executeCommandWithVerification(() => device.toggle());
            } else if (typeof currentReq == "boolean") {
              await executeCommandWithVerification(() => device.set({ set: currentReq }));
            } else if ("dps" in currentReq) {
              await executeCommandWithVerification(() => device.set(currentReq));
            } else if ("multiple" in currentReq) {
              await executeCommandWithVerification(() => device.set({
                multiple: true,
                data: currentReq.data,
              }));
            }
      
            await wait(2000); // Add a 2-second timeout before executing the next command
          }
        } catch (error) {
          node.status({
            fill: "red",
            shape: "dot",
            text: `Error: ${error.message}`,
          });
      
          // Reconnect to device and wait for 3 seconds before retrying
          connectToDevice(3000, "Retry connection after error");
        }
      }
      
      async function executeCommandWithVerification(commandFunc) {
        const MAX_RETRIES = 3;
        let retryCount = 0;
        let success = false;
      
        while (retryCount < MAX_RETRIES && !success) {
          await commandFunc();
          await wait(1000); // Wait for a second before verifying the status
      
          // Assuming we want to compare the 'set' status
          const status = await device.get();
          success = status === desiredStatus; // `desiredStatus` should be defined based on your command
      
          if (!success) {
            retryCount++;
            node.log(`Retrying command... Attempt ${retryCount}/${MAX_RETRIES}`);
          }
        }
      
        if (!success) {
          throw new Error("Failed to set device status after multiple attempts.");
        }
      }
      

      const RETRY_DELAY = 5000; // 5 seconds
      connectToDevice(5, "Deploy connection request for device " + this.Name);

      device.on("disconnected", () => {
        try {
          this.status({
            fill: "red",
            shape: "ring",
            text: "disconnected from device",
          });
          dev_info.available = false;
          msg = { data: dev_info };
          node.send(msg);
          if (set_timeout) {
            timeout = setTimeout(() => {
              connectToDevice(5000, "set timeout for re-connect");
            }, 5000);
          }
        } catch (err) {
        }
      });

      device.on("connected", (connected) => {
        try {
          if (connected) {
            this.status({
              fill: "green",
              shape: "dot",
              text: this.Ip + " at " + getHumanTimeStamp(),
            });
            try {
              clearTimeout(timeout);
            } catch (e) {
            }
          } else {
            this.status({
              fill: "red",
              shape: "ring",
              text: "disconnected at " + getHumanTimeStamp(),
            });
          }
        } catch (err) {

        }
      });

      const MAX_RETRIES = 5;
      let connectionRetries = 0;

      device.on("error", (error) => {
        try {
          this.status({
            fill: "red",
            shape: "ring",
            text: "error: " + error,
          });

          if (error.toString().includes("Error from socket")) {
            try {
              clearTimeout(timeout);
            } catch (e) {
            }
          }

          if (
            error.toString().includes("ETIMEDOUT") ||
            error.toString().includes("ENETUNREACH") ||
            error.toString().includes("EHOSTUNREACH") ||
            error.toString().includes("ECONNREFUSED") ||
            error.toString().includes("ECONNRESET") ||
            error.toString().includes("EPIPE") ||
            error.toString().includes("ENOTCONN") ||
            error.toString().includes("EADDRINUSE") ||
            error.toString().includes("EADDRNOTAVAIL")
          ) {
            node.status({
              fill: "red",
              shape: "ring",
              text: `Host unreachable: ${error}`,
            });

            if (connectionRetries < MAX_RETRIES) {
              connectionRetries++;
              setTimeout(() => {
                connectToDevice(
                  5,
                  `Retry connection attempt for ${node.Name} (${connectionRetries}/${MAX_RETRIES})`
                );
              }, 5000 * connectionRetries); // Increasing delay before each retry
            }
          }
        } catch (err) {
        }
      });

      device.on("data", (data, commandByte) => {
        try {
          if ("commandByte" !== null) {
            dev_info.available = true;
            if (this.renameSchema !== undefined || this.renameSchema !== null) {
              data.dps = checkValidJSON(this.renameSchema)
                ? keyRename(data.dps, JSON.parse(this.renameSchema))
                : data.dps;
            }

            msg = { data: dev_info, commandByte: commandByte, payload: data };
            if (this.filterCB !== "") {
              node.send(filterCommandByte(msg, this.filterCB));
            } else {
              node.send(msg);
            }
          }
        } catch (err) {
        }
      });

      node.on("input", function (msg) {
        try {
          setDevice(msg.payload)
            .then(() => {
              // You can handle successful execution here if necessary
            })
            .catch((err) => {
            });
        } catch (err) {
        }
      });

      this.on("close", function (removed, done) {
        try {
          if (removed) {
            device.isConnected()
              ? disconnectDevice(true)
              : node.log("Device " + this.Name + "not connected on removal");
          } else {
            // this node is being restarted, disconnect the device gracefully or connection will fail. Do not set a timeout
            device.isConnected()
              ? disconnectDevice(true)
              : node.log("Device " + this.Name + "not connected on re-deploy");
          }
          done();
        } catch (err) {
        }
      });
      //
    } catch (error) {
      console.error(
        `Unexpected error occurred in the TuyaNode module: ${error}`
      );
    }
  }
  RED.nodes.registerType("tuya-local", TuyaNode);
};
