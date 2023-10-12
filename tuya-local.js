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
      this.timerOFF = config.timerOFF;
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
          node.warn(
            `Current command queue: ${JSON.stringify(node.commandQueue)}`
          );

          while (node.commandQueue.length > 0) {
            const currentReq = node.commandQueue.shift();

            if (currentReq == "request") {
              await device.get({ schema: true });
            } else if (currentReq == "connect") {
              connectToDevice(
                5,
                "Connection requested by input for device: " + node.Name
              );
            } else if (currentReq == "disconnect") {
              node.log(
                "Disconnection requested by input for device: " + node.Name
              );
              device.disconnect();
            } else if (currentReq == "toggle") {
              await device.toggle();
            } else if (typeof currentReq == "boolean") {
              await device.set({ set: currentReq });
              node.status({
                fill: "green",
                shape: "dot",
                text: "set success at:" + getHumanTimeStamp(),
              });
            } else if ("dps" in currentReq) {
              await device.set(currentReq);
            } else if ("multiple" in currentReq) {
              await device.set({
                multiple: true,
                data: currentReq.data,
              });
            }
            // Add a 2-second timeout before executing the next command
            await wait(2000);
          }
        } catch (error) {
          node.status({
            fill: "red",
            shape: "dot",
            text: `Error: ${error.message}`,
          });

          //Reconnect to device and wait for 3 seconds before retrying
          connectToDevice(3000, "Retry connection after error");
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
              node.log(
                "No timeout defined for " +
                  this.Name +
                  ", probably NodeRED starting"
              );
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
          node.warn(error + " device: " + this.Name);

          if (error.toString().includes("Error from socket")) {
            try {
              node.log(
                "error: Trying to clear a possible timeout timer for device " +
                  this.Name
              );
              clearTimeout(timeout);
            } catch (e) {
              node.log(
                "error: No timeout defined, device " +
                  this.Name +
                  " is probably not powered"
              );
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
              node.warn(
                `Retrying connection for ${node.Name} (${connectionRetries}/${MAX_RETRIES})`
              );
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

            // Check if timerOFF is not 0 and turn off lightbulbs after the specified time
            if (this.timerOFF !== 0) {
              setTimeout(() => {
                node.status({
                  fill: "green",
                  shape: "dot",
                  text: "Timer scheduled for " + this.timerOFF + " seconds",
                });
                setDevice({ dps: 20, set: false }); // Assuming dps 20 is the lightbulb control and 'set' is the property to turn it on/off
              }, this.timerOFF * 1000); // Convert timerOFF to milliseconds
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
            // This node has been deleted disconnect device and not set a timeout for reconnection
            node.log(
              "Node removal, gracefully disconnect device: " + this.Name
            );
            device.isConnected()
              ? disconnectDevice(true)
              : node.log("Device " + this.Name + "not connected on removal");
          } else {
            // this node is being restarted, disconnect the device gracefully or connection will fail. Do not set a timeout
            node.log(
              "Node de-deploy, gracefully disconnect device: " + this.Name
            );
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
