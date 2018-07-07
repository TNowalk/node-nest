'use strict';

require('dotenv').config();
const https = require('https');
const Influx = require('influx');
const winston = require('winston');

const ENVIRONMENT = process.env.ENVIRONMENT || 'production';
const DEFAULT_NEST_URL = 'developer-api.nest.com';
const DEFAULT_NEST_PORT = 443;
const POLLING_FREQUENCY = process.env.POLLING_FREQUENCY || 60000;

winston.level = process.env.LOG_LEVEL || 'error';

let dynamicNestConfig = {
  host: null,
  port: null
};

if (process.env.NEST_TOKEN === undefined) {
  winston.error('Missing Nest API token');
  process.exit(1);
}

if (process.env.INFLUXDB_HOST === undefined) {
  winston.error('Missing InfluxDB Host URL');
  process.exit(1);
}

const influxdb = new Influx.InfluxDB({
  host: process.env.INFLUXDB_HOST,
  database: 'environment',
  schema: [
    {
      measurement: 'sensor.temperature.reading',
      fields: {
        ambient: Influx.FieldType.FLOAT,
        target: Influx.FieldType.FLOAT,
        target_high: Influx.FieldType.FLOAT,
        target_low: Influx.FieldType.FLOAT
      },
      tags: [
        'device_id',
        'room'
      ]
    },{
      measurement: 'sensor.humidity.reading',
      fields: {
        humidity: Influx.FieldType.INTEGER
      },
      tags: [
        'device_id',
        'room'
      ]
    },{
      measurement: 'device.state.reading',
      fields: {
        fan: Influx.FieldType.INTEGER,
        leaf: Influx.FieldType.INTEGER,
        mode: Influx.FieldType.STRING,
        state: Influx.FieldType.STRING,
        online: Influx.FieldType.INTEGER,
        mode_off: Influx.FieldType.INTEGER,
        mode_heat: Influx.FieldType.INTEGER,
        mode_cool: Influx.FieldType.INTEGER,
        mode_heat_cool: Influx.FieldType.INTEGER,
        mode_eco: Influx.FieldType.INTEGER,
        state_off: Influx.FieldType.INTEGER,
        state_cooling: Influx.FieldType.INTEGER,
        state_heating: Influx.FieldType.INTEGER
      },
      tags: [
        'device_id',
        'device_type',
        'room'
      ]
    }
  ]
});

winston.info('[InfluxDB] Schema loaded');

influxdb.getDatabaseNames()
  .then(names => {
    if (!names.includes('environment')) {
      winston.error('Missing InfluxDB database called `environment`');
      process.exit(1);
    } else {
      winston.info('[InfluxDB] Found `environment` database');
    }
  })
  .catch(err => {
    winston.error('Could not connect to InfluxDB: ', err.code);
    process.exit(1);
  });

winston.info(`Begin Polling in ${POLLING_FREQUENCY / 1000}s`);
let interval = setInterval(() => {
  nest().then((data) => {
    if (data.devices && data.devices.thermostats) {
      let deviceIds = Object.keys(data.devices.thermostats);

      if (deviceIds.length == 0) {
        winston.info('[NestAPI] No thermostats found');
        return;
      }

      winston.info(`[NestAPI] Found ${deviceIds.length} thermostats`);

      for (let i = 0; i < deviceIds.length; i++) {
        let device = data.devices.thermostats[deviceIds[i]];

        let structure = data.structures[device.structure_id];
        let where = structure.wheres[device.where_id];

        winston.info(`[InfluxDB] Writing data for ${device.name}`);
        influxdb.writePoints([
          {
            measurement: 'sensor.temperature.reading',
            tags: {
              device_id: device.device_id,
              room: where.name
            },
            fields: {
              ambient: device.ambient_temperature_f,
              target_high: device.target_temperature_high_f,
              target_low: device.target_temperature_low_f,
              target: device.target_temperature_f
            },
          },{
            measurement: 'sensor.humidity.reading',
            tags: {
              device_id: device.device_id,
              room: where.name
            },
            fields: {
              humidity: device.humidity
            },
          },{
            measurement: 'device.state.reading',
            tags: {
              device_id: device.device_id,
              room: where.name,
              device_type: 'nest'
            },
            fields: {
              fan: device.has_fan ? 1 : 0,
              leaf: device.has_leaf ? 1 : 0,
              mode: device.hvac_mode,
              state: device.hvac_state,
              online: device.is_online ? 1 : 0,
              mode_off: device.hvac_mode == 'off' ? 1 : 0,
              mode_heat: device.hvac_mode == 'heat' ? 1 : 0,
              mode_cool: device.hvac_mode == 'cool' ? 1 : 0,
              mode_heat_cool: device.hvac_mode == 'heat-cool' ? 1 : 0,
              mode_eco: device.hvac_mode == 'eco' ? 1 : 0,
              state_off: device.hvac_state == 'off' ? 1 : 0,
              state_cooling: device.hvac_state == 'cooling' ? 1 : 0,
              state_heating: device.hvac_state == 'heating' ? 1 : 0
            }
          }
        ]).catch(err => {
          winston.error(`[InfluxDB] Error saving data: ${err.stack}`)
        })
      }
    } else {
      winston.error('[NestAPI] Unexpected response');
    }
  })
  .catch((err) => {
      winston.error(err);
  })
}, POLLING_FREQUENCY);

function nest(url, port, redirectCount) {
  redirectCount = redirectCount || 0;

  if (redirectCount > 10) {
      throw new Error('[NestAPI] Redirected too many times');
  }

  return new Promise((resolve, reject) => {
    if (!url) {
      url = dynamicNestConfig.host || DEFAULT_NEST_URL;
    }

    if (!port) {
      port = dynamicNestConfig.port || DEFAULT_NEST_PORT;
    }

    let opts = {
        host: url,
        port: port,
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.NEST_TOKEN}`
        }
    };

    winston.info(`[GET] https://${url}:${port}`);
    let req = https.request(opts, function (res) {
        var responseString = "";

        if (res.statusCode === 307) {
          // Redirect - Capture new location info and recall
          let location = res.headers.location.replace('https://', '').split(':');

          dynamicNestConfig.host = location[0];
          dynamicNestConfig.port = location[1].replace('/', '');

          winston.info(`[NestAPI] Redirect detected, using https://${dynamicNestConfig.host}:${dynamicNestConfig.port}`)

          resolve(null);
        }

        if (res.statusCode === 404) {
          dynamicNestConfig.host = null;
          dynamicNestConfig.port = null;

          winston.info(`[NestAPI] URL Not Found (404) detected, reverting to default https://${DEFAULT_NEST_URL}:${DEFAULT_NEST_PORT}`)

          resolve(null);
        }

        if (res.statusCode === 429) {
          winston.info('[NestAPI] Too Many Requests (429) detected, unhandled status code')
          resolve(null);
        }

        res.on("data", function (data) {
          responseString += data;
        });

        res.on("end", function () {
          if (responseString.length) {
            responseString = JSON.parse(responseString);
          }
          resolve(responseString);
        });
    });

    req.on('error', function(e) {
      reject(e.message);
    });

    req.end();
  }).then((data) => {
    if (!data) {
      return nest(null, null, redirectCount + 1);
    } else {
      return data;
    }
  });
}
