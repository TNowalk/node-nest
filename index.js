'use strict';

require('dotenv').config();
const https = require('https');
const Influx = require('influx');
const winston = require('winston');
// TODO: Add raspi-sonar

const ENVIRONMENT = process.env.ENVIRONMENT || 'production';
const DEFAULT_NEST_URL = 'developer-api.nest.com';
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

// TODO: Extract hvac mode `hvac_mode`
// TODO: Extract is online `is_online`
// TODO: Extract has leaf `has_fan`

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
        // console.log('device', device);

        let structure = data.structures[device.structure_id];
        let where = structure.wheres[device.where_id];

        // console.log('structure', structure);
        // console.log('where', where);

        // TODO: Batch into a single write
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
              target_low: device.target_temperature_low_f
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
      port = dynamicNestConfig.port || 443;
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
