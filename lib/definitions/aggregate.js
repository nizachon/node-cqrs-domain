'use strict';

var Definition = require('../definitionBase'),
  util = require('util'),
  _ = require('lodash'),
  debug = require('debug')('domain:aggregate'),
  AggregateModel = require('../aggregateModel'),
  dotty = require('dotty'),
  DefaultCommandHandler = require('../defaultCommandHandler'),
  uuid = require('node-uuid').v4,
  async = require('async');

/**
 * Aggregate constructor
 * @param {Object} meta            Meta infos like: { name: 'name', version: 1 }
 * @param {Object} modelInitValues Initialization values for model like: { emails: [] } [optional]
 * @constructor
 */
function Aggregate (meta, modelInitValues) {
  Definition.call(this, meta);

  meta = meta || {};

  this.version = meta.version || 0;

  this.defaultCommandPayload = meta.defaultCommandPayload || '';
  this.defaultEventPayload = meta.defaultEventPayload || '';
  this.defaultPreConditionPayload = meta.defaultPreConditionPayload || '';

  this.commands = [];
  this.events = [];
  this.businessRules = [];
  this.preConditions = [];
  this.commandHandlers = [];

  this.snapshotConversions = {};

  this.idGenerator(function () {
    return uuid().toString();
  });

  this.modelInitValues = modelInitValues || {};

  this.defaultCommandHandler = new DefaultCommandHandler(this);
  this.defaultCommandHandler.useAggregate(this);
}

util.inherits(Aggregate, Definition);

/**
 * Returns the apply function for the AggregateModel.
 * @param {Aggregate}      aggregate      The aggregate object.
 * @param {AggregateModel} aggregateModel The aggregateModel object.
 * @param {Command}        cmd            The command object that caused this.
 * @returns {Function}
 */
function applyHelper (aggregate, aggregateModel, cmd) {
  return function (name, payload) {
    aggregateModel.set = function () {
      AggregateModel.prototype.set.apply(aggregateModel, _.toArray(arguments));
    };

    var evt;

    if (!payload) {
      if (_.isString(name)) {
        evt = {};
        dotty.put(evt, aggregate.definitions.event.name, name);
      } else if (_.isObject(name)) {
        evt = name;
      }
    } else {
      evt = {};
      dotty.put(evt, aggregate.definitions.event.name, name);
      dotty.put(evt, aggregate.definitions.event.payload, payload);
    }

    if (!!aggregate.definitions.event.meta && !!aggregate.definitions.command.meta) {
      dotty.put(evt, aggregate.definitions.event.meta, dotty.get(cmd, aggregate.definitions.command.meta));
    }

    var revision = aggregateModel.getRevision() + 1;
    aggregateModel.setRevision(revision);
    dotty.put(evt, aggregate.definitions.event.revision, revision);
    dotty.put(evt, aggregate.definitions.event.aggregateId, aggregateModel.id);
    dotty.put(evt, aggregate.definitions.event.correlationId, dotty.get(cmd, aggregate.definitions.command.id));

    if (!!aggregate.definitions.event.version) {
      if (!dotty.exists(evt, aggregate.definitions.event.version)) {
        // if version is not defined in event, search the latest version number...
        var evtName = dotty.get(evt, aggregate.definitions.event.name);
        var maxVersion = _.reduce(aggregate.getEvents(), function (res, e) {
          if (e.name !== evtName) {
            return res;
          }

          var v = e.version || 0;
          if (v > res) {
            return v;
          }
          return res;
        }, 0);
        dotty.put(evt, aggregate.definitions.event.version, maxVersion);
      }
    }

    if (!!aggregate.definitions.event.aggregate && !!aggregate.definitions.command.aggregate) {
      var aggName = dotty.get(cmd, aggregate.definitions.command.aggregate);
      dotty.put(evt, aggregate.definitions.event.aggregate, aggName || aggregate.name);
    }

    if (!!aggregate.definitions.event.context && !!aggregate.definitions.command.context) {
      var ctxName = dotty.get(cmd, aggregate.definitions.command.context);
      dotty.put(evt, aggregate.definitions.event.context, ctxName || aggregate.context.name);
    }

    aggregateModel.addUncommittedEvent(evt);

    // apply the event
    debug('apply the event');
    aggregate.apply(evt, aggregateModel);

    aggregateModel.set = function () {
      throw new Error('You are not allowed to set a value in this step!');
    };
  };

}

_.extend(Aggregate.prototype, {

  /**
   * Inject idGenerator function.
   * @param   {Function}  fn The function to be injected.
   * @returns {Aggregate}    to be able to chain...
   */
  idGenerator: function (fn) {
    if (fn.length === 0) {
      fn = _.wrap(fn, function(func, callback) {
        callback(null, func());
      });
    }

    this.getNewId = fn;

    return this;
  },

  /**
   * Inject the context module.
   * @param {Context} context The context module to be injected.
   */
  defineContext: function (context) {
    if (!context || !_.isObject(context)) {
      var err = new Error('Please inject a valid context object!');
      debug(err);
      throw err;
    }

    this.context = context;
  },

  /**
   * Add command module.
   * @param {Command} command The command module to be injected.
   */
  addCommand: function (command) {
    if (!command || !_.isObject(command)) {
      var err = new Error('Please inject a valid command object!');
      debug(err);
      throw err;
    }

    if (!command.payload) {
      command.payload = this.defaultCommandPayload;
    }

    command.defineAggregate(this);

    if (this.commands.indexOf(command) < 0) {
      this.commands.push(command);
    }
  },

  /**
   * Add event module.
   * @param {Event} event The event module to be injected.
   */
  addEvent: function (event) {
    if (!event || !_.isObject(event)) {
      var err = new Error('Please inject a valid event object!');
      debug(err);
      throw err;
    }

    if (!event.payload) {
      event.payload = this.defaultEventPayload;
    }

    if (this.events.indexOf(event) < 0) {
      this.events.push(event);
    }
  },

  /**
   * Add businessRule module.
   * @param {BusinessRule} businessRule The businessRule module to be injected.
   */
  addBusinessRule: function (businessRule) {
    if (!businessRule || !_.isObject(businessRule)) {
      var err = new Error('Please inject a valid businessRule object!');
      debug(err);
      throw err;
    }

    if (this.businessRules.indexOf(businessRule) < 0) {
      this.businessRules.push(businessRule);
      this.businessRules = _.sortBy(this.businessRules, function(br) {
        return br.priority;
      });
    }
  },

  /**
   * Add pre-condition module.
   * @param {Function} preCond The pre-condition module that should be injected.
   */
  addPreCondition: function (preCond) {
    if (!preCond || !_.isObject(preCond)) {
      var err = new Error('Please inject a valid preCondition object!');
      debug(err);
      throw err;
    }

    if (!preCond.payload) {
      preCond.payload = this.defaultPreConditionPayload;
    }

    if (this.preConditions.indexOf(preCond) < 0) {
      this.preConditions.push(preCond);
      this.preConditions = _.sortBy(this.preConditions, function(pc) {
        return pc.priority;
      });
    }
  },

  /**
   * Add commandHandler module.
   * @param {CommandHandler} commandHandler The commandHandler module to be injected.
   */
  addCommandHandler: function (commandHandler) {
    if (!commandHandler || !_.isObject(commandHandler) || !_.isFunction(commandHandler.useAggregate)) {
      var err = new Error('Please inject a valid commandHandler object!');
      debug(err);
      throw err;
    }

    commandHandler.useAggregate(this);

    if (this.commandHandlers.indexOf(commandHandler) < 0) {
      this.commandHandlers.push(commandHandler);
    }
  },

  /**
   * Returns the command modules by command name.
   * @param {String} name The command name.
   * @returns {Array}
   */
  getCommandsByName: function (name) {
    if (!name || !_.isString(name)) {
      var err = new Error('Please pass a valid string as name!');
      debug(err);
      throw err;
    }

    return _.filter(this.commands, function (cmd) {
      return cmd.name === name;
    });
  },

  /**
   * Returns the command module by command name and command version.
   * @param {String} name    The command name.
   * @param {Number} version The command version. [optional; default 0]
   * @returns {Command}
   */
  getCommand: function (name, version) {
    if (!name || !_.isString(name)) {
      var err = new Error('Please pass a valid string as name!');
      debug(err);
      throw err;
    }

    version = version || 0;

    if (!_.isNumber(version)) {
      var err = new Error('Please pass a valid number as version!');
      debug(err);
      throw err;
    }

    return _.find(this.commands, function (cmd) {
      return cmd.name === name && cmd.version === version;
    });
  },

  /**
   * Returns all command modules.
   * @returns {Array}
   */
  getCommands: function () {
    return this.commands;
  },

  /**
   * Returns the event module by event name and event version.
   * @param {String} name    The event name.
   * @param {Number} version The event version. [optional; default 0]
   * @returns {Event}
   */
  getEvent: function (name, version) {
    if (!name || !_.isString(name)) {
      var err = new Error('Please pass a valid string as name!');
      debug(err);
      throw err;
    }

    version = version || 0;

    if (!_.isNumber(version)) {
      var err = new Error('Please pass a valid number as version!');
      debug(err);
      throw err;
    }

    return _.find(this.events, function (evt) {
      return evt.name === name && evt.version === version;
    });
  },

  /**
   * Returns all event modules.
   * @returns {Array}
   */
  getEvents: function () {
    return this.events;
  },

  /**
   * Returns all business rule modules.
   * @returns {Array}
   */
  getBusinessRules: function () {
    return this.businessRules;
  },

  /**
   * Returns all commandHandler modules.
   * @returns {Array}
   */
  getCommandHandlers: function () {
    return this.commandHandlers;
  },

  /**
   * Returns the commandHandler module by command name and command version.
   * @param {String} name    The command name.
   * @param {Number} version The command version. [optional; default 0]
   * @returns {CommandHandler}
   */
  getCommandHandler: function (name, version) {
    if (!name || !_.isString(name)) {
      var err = new Error('Please pass a valid string as name!');
      debug(err);
      throw err;
    }

    version = version || 0;

    if (!_.isNumber(version)) {
      var err = new Error('Please pass a valid number as version!');
      debug(err);
      throw err;
    }

    var handler =  _.find(this.commandHandlers, function (cmdHnd) {
      return cmdHnd.name === name && cmdHnd.version === version;
    });

    if (handler) {
      return handler;
    }

    return this.defaultCommandHandler;
  },

  /**
   * Returns a new aggregate model, to be used in the command and event functions.
   * @param {String} id The aggregate id.
   * @returns {AggregateModel}
   */
  create: function (id) {
    if (!id || !_.isString(id)) {
      var err = new Error('Please pass a valid string as id!');
      debug(err);
      throw err;
    }

    return new AggregateModel(id, this.modelInitValues);
  },

  /**
   * Validates the requested command.
   * @param {Object} cmd The command object
   * @returns {ValidationError}
   */
  validateCommand: function (cmd) {
    var cmdName = dotty.get(cmd, this.definitions.command.name);

    if (!cmdName) {
      var err = new Error('command has no command name in ' + this.definitions.command.name);
      debug(err);
      throw err;
    }

    var version = 0;
    if (!!this.definitions.command.version) {
      version = dotty.get(cmd, this.definitions.command.version);
    }

    var command = this.getCommand(cmdName, version);
    if (!command) {
      var err = new Error('Command "' + cmdName + '" not found!');
      debug(err);
      throw err;
    }

    return command.validate(cmd);
  },

  /**
   * Checks for aggregate-specific pre-conditions.
   * @param {Object}         cmd            The command that was handled.
   * @param {AggregateModel} aggregateModel The aggregate values.
   * @param {Function}       callback       The function, that will be called when this action is completed.
   *                                        `function(err){}`
   */
  checkAggregatePreConditions: function (cmd, aggregateModel, callback) {
    if (this.preConditions.length === 0) {
      debug('no pre-condition for ' + this.name);
      return callback(null);
    }

    async.eachSeries(this.preConditions, function (preCondition, callback) {
      preCondition.check(_.cloneDeep(cmd), aggregateModel, callback);
    }, callback);
  },

  /**
   * Checks for pre-conditions.
   * @param {Object}         cmd            The command that was handled.
   * @param {AggregateModel} aggregateModel The aggregate values.
   * @param {Function}       callback       The function, that will be called when this action is completed.
   *                                        `function(err){}`
   */
  checkPreConditions: function (cmd, aggregateModel, callback) {
    var self = this;

    this.checkAggregatePreConditions(cmd, aggregateModel, function (err) {
      if (err) {
        return callback(err);
      }

      var cmdName = dotty.get(cmd, self.definitions.command.name);

      if (!cmdName) {
        var err = new Error('command has no command name in ' + self.definitions.command.name);
        debug(err);
        throw err;
      }

      var version = 0;
      if (!!self.definitions.command.version) {
        version = dotty.get(cmd, self.definitions.command.version);
      }

      var command = self.getCommand(cmdName, version);
      if (!command) {
        var err = new Error('Command "' + cmdName + '" not found!');
        debug(err);
        throw err;
      }

      command.checkPreConditions(cmd, aggregateModel, callback);
    });
  },

  /**
   * Checks business rules.
   * @param {Object}   changed  The new aggregate values.
   * @param {Object}   previous The previous aggregate values.
   * @param {Array}    events   All new generated events.
   * @param {Object}   command  The command that was handled.
   * @param {Function} callback The function, that will be called when this action is completed.
   *                            `function(err){}`
   */
  checkBusinessRules: function (changed, previous, events, command, callback) {
    async.eachSeries(this.getBusinessRules(), function (rule, callback) {
      rule.check(changed, previous, events, command, callback);
    }, callback);
  },

  /**
   * Handles the passed command and checks the business rules.
   * @param {AggregateModel}  aggregateModel The aggregateModel that should be used.
   * @param {Object}          cmd            The command that was handled.
   * @param {Function}        callback       The function, that will be called when this action is completed.
   *                                         `function(err){}`
   */
  handle: function (aggregateModel, cmd, callback) {
    var cmdName = dotty.get(cmd, this.definitions.command.name);
    if (!cmdName) {
      var err = new Error('command has no command name in ' + this.definitions.command.name);
      debug(err);
      return callback(err);
    }

    var version = 0;
    if (!!this.definitions.command.version) {
      version = dotty.get(cmd, this.definitions.command.version);
    }

    var command = this.getCommand(cmdName, version);
    if (!command) {
      var err = new Error('Command "' + cmdName + '" not found!');
      debug(err);
      return callback(err);
    }

    var self = this;

    aggregateModel.set = function () {
      throw new Error('You are not allowed to set a value in this step!');
    };

    this.checkPreConditions(cmd, aggregateModel, function (err) {
      if (err) {
        return callback(err);
      }

      var previousModel = new AggregateModel(aggregateModel.id, aggregateModel.toJSON());

      // attach apply function
      aggregateModel.apply = applyHelper(self, aggregateModel, cmd);

      debug('handle command');
      command.handle(cmd, aggregateModel);

      // remove apply function
      delete aggregateModel.apply;

      var uncommittedEvents = aggregateModel.getUncommittedEvents();

      async.each(uncommittedEvents, function (evt, callback) {
        var isEvtIdDefined = !!dotty.get(evt, self.definitions.event.id);
        if (isEvtIdDefined) {
          debug('event id already defined');
          return callback(null);
        }

        // generate new id for event
        debug('generate new id for event');
        self.getNewId(function (err, id) {
          if (err) {
            return callback(err);
          }

          dotty.put(evt, self.definitions.event.id, id);
          callback(null);
        });
      }, function (err) {
        if (err) {
          return callback(err);
        }

        // check business rules
        debug('check business rules');
        self.checkBusinessRules(aggregateModel, previousModel, uncommittedEvents, cmd, function (err) {
          if (!err) {
            return callback(null);
          }

          // clean up...
          aggregateModel.reset(previousModel.toJSON());
          aggregateModel.clearUncommittedEvents();
          callback(err);
        });
      });
    });
  },

  /**
   * Applies the passed events to the passed aggregateModel.
   * @param {Array || Object} events         The events that should be applied.
   * @param {AggregateModel}  aggregateModel The aggregateModel that should be used.
   */
  apply: function (events, aggregateModel) {
    if (!events) {
      return;
    }

    if (!_.isArray(events)) {
      events = [events];
    }

    var self = this;

    events.forEach(function (evt) {
      var evtName = dotty.get(evt, self.definitions.event.name);
      if (!evtName) {
        var err = new Error('event has no event name in ' + self.definitions.event.name);
        debug(err);
        throw err;
      }

      var version = 0;
      if (!!self.definitions.event.version) {
        version = dotty.get(evt, self.definitions.event.version);
      }

      var event = self.getEvent(evtName, version);

      if (!event) {
        var err = new Error('Event "' + evtName + '" not found!');
        debug(err);
        throw err;
      }

      event.apply(evt, aggregateModel);
    });
  },

  /**
   * Loads the aggregateModel with the data of the snapshot and the events.
   * And returns true if a new snapshot should be done.
   * @param {AggregateModel}  aggregateModel The aggregateModel that should be used.
   * @param {Object}          snapshot       The snapshot object.
   * @param {Array}           events         The events that should be applied.
   * @param {Number}          loadingTime    The loading time in ms of the eventstore data.
   * @returns {boolean}
   */
  loadFromHistory: function (aggregateModel, snapshot, events, loadingTime) {
    var self = this;

    var isSnapshotNeeded = false;

    if (snapshot) {
      // load snapshot
      debug('load snapshot from history');
      if (snapshot.version === this.version) {
        aggregateModel.set(snapshot.data);
      } else {
        if (!this.snapshotConversions[snapshot.version]) {
          var err = new Error('No snapshot conversion defined!');
          debug(err);
          throw err;
        }
        debug('convert snapshot from history');
        this.snapshotConversions[snapshot.version](snapshot.data, aggregateModel);
        isSnapshotNeeded = true;
      }
      aggregateModel.setRevision(snapshot.revision);
    }

    if (events && events.length > 0) {
      // load events
      debug('load events from history');
      var maxRevision = _.reduce(events, function (res, evt) {
        var rev = dotty.get(evt, self.definitions.event.revision);
        if (rev > res) {
          return rev;
        }
        return res;
      }, 0);

      this.apply(events, aggregateModel);

      aggregateModel.setRevision(maxRevision);

      if (!isSnapshotNeeded) {
        isSnapshotNeeded = this.isSnapshotNeeded(loadingTime, events, aggregateModel.toJSON());
      }
    }

    return isSnapshotNeeded;
  },

  /**
   * Returns true if a new snapshot should be done.
   * @param {Number} loadingTime    The loading time in ms of the eventstore data.
   * @param {Array}  events         The loaded events.
   * @param {Object} aggregateModel The aggregate json object. [could be used for other algorithms]
   * @returns {boolean}
   */
  isSnapshotNeeded: function (loadingTime, events, aggregateModel) {
    var snapshotThreshold = 100;
    if (this.options.snapshotThreshold) {
      snapshotThreshold = this.options.snapshotThreshold;
    }

    if (this.options.snapshotThresholdMs) {
      return loadingTime >= this.options.snapshotThresholdMs;
    }

    return events.length >= snapshotThreshold;
  },

  /**
   * Defines the algorithm to identify if a snapshot is needed to be done.
   * @param {Function} fn Function containing the algorithm. Should return true or false.
   *                      `function(loadingTime, events, aggregateModel){}`
   */
  defineSnapshotNeed: function (fn) {
    if (!_.isFunction(fn)) {
      throw new Error('Please pass in a function');
    }

    this.isSnapshotNeeded = fn;
    return this;
  },

  /**
   * Defines a new conversion function for older snapshot versions.
   * @param {Object}   meta Meta infos like: { name: 'name', version: 10 }
   * @param {Function} fn   Function containing the conversion rule
   *                        `function(snapshotData, aggregateModel){}`
   * @returns {Aggregate}
   */
  defineSnapshotConversion: function (meta, fn) {
    if (!_.isObject(meta) || meta.version === undefined || meta.version === null || !_.isNumber(meta.version)) {
      throw new Error('Please pass in a version');
    }
    if (!_.isFunction(fn)) {
      throw new Error('Please pass in a function');
    }

    this.snapshotConversions[meta.version] = fn;
    return this;
  }

});

module.exports = Aggregate;
