import crypto from "crypto";

import { v4 as uuidv4 } from "uuid";
import { server as WebSocketServer } from "websocket";

import { Game } from "./game";
import { log_info, log_err, log_debug } from "./logging";

export default class GameServer {
    constructor(http_server) {
        this.http_server = http_server;

        this.runtime_server_identifier = crypto.randomBytes(16).toString("hex");

        this.running_games = {};
        this.clients = {};
        this.clients_secrets = {};
        this.uuid_to_game = {};

        this.clients_logged_out_at = {};
        this.client_forget_threshold = 1000 * 60 * 60 * 2;
    }

    static check_origin(origin) {
        log_info("Checking origin: " + origin);
        return true;
    }

    report_statistics() {
      let games_count = Object.keys(this.running_games).length;
      let clients_count = Object.keys(this.clients).length;

      log_info(`There are ${clients_count} clients connected in ${games_count} games.`);
    }

    start() {
        this.ws_server = new WebSocketServer({
            httpServer: this.http_server,
            autoAcceptConnections: false
        });

        log_info("Websockets server started.");

        this.ws_server.on('request', request => {
            if (!GameServer.check_origin(request.origin)) {
                request.reject();
                log_err('Connection from origin ' + request.origin + ' rejected.');
                return;
            }

            var connection = request.accept('pb-protocol', request.origin);
            log_info('New peer connected from ' + connection.remoteAddress + ' successfully.');

            // We send the server's runtime identifier. This allows the client to know if
            // it need to fully reload.
            this.send_message(connection, "set-server-runtime-identifier", {
              runtime_identifier: this.runtime_server_identifier
            });

            connection.on('message', message => {
                if (message.type === 'utf8') {
                    log_debug('[<-] ' + message.utf8Data);
                    let json_message = JSON.parse(message.utf8Data);

                    let uuid = (json_message.uuid || "").toLowerCase().trim();
                    let slug = (json_message.slug || "").toLowerCase().trim();
                    let action = (json_message.action || "").toLowerCase().trim();

                    if (!action) {
                        log_err("Ignoring action-less message from " + (uuid || "an unknown client") + ".");
                        return;
                    }

                    let uuid_promise = null;

                    // If the user does not have an UUID, we generate one.
                    // We also generate one if we don't know this UUID (without
                    // this, if we stay on a tab when the server restarts, we
                    // are unable to connect from this tab).
                    if (!uuid) {
                        uuid = uuidv4().toLowerCase();
                        let secret = crypto.randomBytes(16).toString("hex");

                        this.clients[uuid] = connection;
                        this.clients_secrets[uuid] = secret;

                        uuid_promise = this.send_message(connection, "set-uuid", {uuid: uuid, secret: secret});
                    }

                    // If the user is presenting an UUID and a secret, but we don't recognize it,
                    // we send a “fake” runtime identifier to force the client to reload and restart
                    // the identification process.
                    else if (json_message.secret && !this.clients_secrets[uuid]) {
                      this.send_message(connection, "set-server-runtime-identifier", {
                        runtime_identifier: crypto.randomBytes(16).toString("hex")
                      });

                      return;
                    }

                    // Else we check the secret.
                    else {
                        if ((this.clients_secrets[uuid] || "") !== (json_message.secret || "").trim()) {
                            log_err(`Client with UUID ${uuid} sent a badly authenticated message. Ignored.`);
                            log_err(`Server secret: ${this.clients_secrets[uuid] || "(empty)"}`);
                            log_err(`Client secret: ${json_message.secret || "(empty)"}`);
                            return;
                        }
                    }

                    (uuid_promise || Promise.resolve()).then(() => {
                        if (this.clients_logged_out_at[uuid]) {
                          delete this.clients_logged_out_at[uuid];
                        }

                        this.handle_message(connection, uuid, this.running_games[slug], action, json_message);
                    });
                }
            });

            connection.on('close', (reasonCode, description) => {
                log_info('Peer ' + connection.remoteAddress + ' disconnected.');

                // We log it out from the game, if any.
                let uuid = this.get_uuid_for_connection(connection);
                let game = this.uuid_to_game[uuid];

                if (game) {
                    game.left(uuid);
                }

                // We DON'T remove the client' secret to allow for reconnection
                // using the same UUID/secret.
                delete this.clients[uuid];
                delete this.uuid_to_game[uuid];

                this.clients_logged_out_at[uuid] = new Date().getTime();

                this.report_statistics();
            });
        });

        this.start_cleanup_task();
    }

    start_cleanup_task() {
      setInterval(() => {
        let now = new Date().getTime();

        Object.keys(this.clients_logged_out_at).forEach(uuid => {
          if (now - this.clients_logged_out_at[uuid] > this.client_forget_threshold) {
            delete this.clients_secrets[uuid];
            delete this.clients_logged_out_at[uuid];
          }
        });
      }, 1000 * 60 * 20);
    }

    get_game_for_uuid(uuid) {
        return this.uuid_to_game[uuid];
    }

    get_connection_for_uuid(uuid) {
        return this.clients[uuid];
    }

    get_uuid_for_connection(connection) {
        return Object.keys(this.clients).filter(client_uuid => this.clients[client_uuid] === connection)[0];
    }

    handle_message(connection, user_uuid, game, action, message) {
        switch (action) {
            case "join-game":
                if (game) {
                    this.join_game(connection, user_uuid, message.pseudonym, game);
                }
                else {
                    this.create_game(connection, user_uuid, message.pseudonym);
                }
                break;
            case "update-config":
                if (!game || !message.configuration) return;
                game.update_configuration(connection, user_uuid, message.configuration);
                break;

            case "start-game":
                if (!game) return;
                game.start(connection, user_uuid);

            case "send-answers":
                if (!game || !message.answers) return;
                game.receive_answers(user_uuid, message.answers);

            case "send-vote":
                if (!game || !message.vote || !message.vote.uuid || !message.vote.category) return;
                game.receive_vote(user_uuid, message.vote.category, message.vote.uuid, message.vote.vote);
                break;

            case "vote-ready":
                if (!game) return;
                game.receive_vote_ready(user_uuid);
                break;

            case "restart":
                if (!game) return;
                game.restart(user_uuid);
                break;
        }
    }

    send_message(connection, action, message) {
        return new Promise((resolve, reject) => {
            message.action = action;

            let raw_message = JSON.stringify(message);

            connection.sendUTF(raw_message);

            log_debug('[->] ' + raw_message);
            resolve();
        });
    }

    create_game(connection, user_uuid, pseudonym) {
        let slug = crypto.randomBytes(4).toString("hex");
        log_info("Creating game with slug " + slug + " for player " + pseudonym + " (" + user_uuid + ")");

        this.send_message(connection, "set-slug", {slug: slug}).then(() => {
            let game = new Game(slug, this);
            this.running_games[slug] = game;

            this.join_game(connection, user_uuid, pseudonym, game);
        });
    }

    join_game(connection, user_uuid, pseudonym, game) {
        game.join(connection, user_uuid, pseudonym);
        this.uuid_to_game[user_uuid] = game;

        this.report_statistics();
    }

    delete_game(slug) {
      delete this.running_games[slug];
    }
}