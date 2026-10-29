routerAdd(
  'GET',
  '/backend/v1/instance/{id}/qr',
  (e) => {
    const id = e.request.pathValue('id')
    let instance
    try {
      instance = $app.findRecordById('whatsapp_instances', id)
    } catch (_) {
      return e.notFoundError('Instance not found')
    }

    if (instance.getString('user_id') !== e.auth?.id) {
      return e.forbiddenError('Access denied')
    }

    let evoUrl = $secrets.get('EVOLUTION_API_URL')
    const evoKey = $secrets.get('EVOLUTION_API_KEY')
    const instanceName = instance.getString('instance_name')

    if (!evoUrl || !evoKey) {
      return e.internalServerError(
        'Configuração da Evolution API ausente (EVOLUTION_API_URL / EVOLUTION_API_KEY).',
      )
    }

    if (evoUrl.endsWith('/')) {
      evoUrl = evoUrl.slice(0, -1)
    }

    // Extract the QR code from any shape the Evolution API returns:
    //  - state "connecting": flat { pairingCode, code, base64, count }
    //  - state "close"/other: { instance: {...}, qrcode: { base64, code, ... } }
    const extractQr = (json) => {
      if (!json) return ''
      return (
        json.base64 ||
        json.qrcode?.base64 ||
        json.data?.base64 ||
        json.data?.qrcode?.base64 ||
        json.response?.base64 ||
        json.response?.qrcode?.base64 ||
        ''
      )
    }

    const decodeBody = (res) => {
      try {
        if (res.body) return new TextDecoder().decode(res.body)
      } catch (_) {}
      return ''
    }

    const callConnect = () =>
      $http.send({
        url: evoUrl + '/instance/connect/' + instanceName,
        method: 'GET',
        headers: { apikey: evoKey },
        timeout: 15,
      })

    const createEvolutionInstance = () => {
      const webhookUrl = ($secrets.get('APP_WEBHOOK_URL') || '').replace(/\/+$/, '')
      const createBody = {
        instanceName: instanceName,
        qrcode: true,
        integration: 'WHATSAPP-BAILEYS',
      }
      if (webhookUrl) {
        createBody.webhook = {
          url: webhookUrl + '/backend/v1/webhook/evolution',
          byEvents: false,
          base64: false,
          enabled: true,
          events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'],
        }
      }
      return $http.send({
        url: evoUrl + '/instance/create',
        method: 'POST',
        headers: { apikey: evoKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(createBody),
        timeout: 20,
      })
    }

    let lastError = ''

    try {
      let res = callConnect()
      let json = res.json || null

      if (res.statusCode < 200 || res.statusCode >= 300 || (json && json.error)) {
        lastError =
          (json && (json.message || json.error?.message)) ||
          decodeBody(res) ||
          'HTTP ' + res.statusCode

        // The instance may not exist on the Evolution side (e.g. it was created
        // before the API credentials were configured). Recover by creating it
        // and asking for the QR again.
        const missingInstance =
          res.statusCode === 400 ||
          res.statusCode === 404 ||
          String(lastError).indexOf('does not exist') !== -1

        if (missingInstance) {
          $app
            .logger()
            .warn(
              'Evolution QR: instance missing, recreating it',
              'instance',
              instanceName,
              'statusCode',
              res.statusCode,
            )

          const createRes = createEvolutionInstance()
          if (createRes.statusCode >= 200 && createRes.statusCode < 300) {
            res = callConnect()
            json = res.json || null
          } else {
            lastError =
              (createRes.json && (createRes.json.message || createRes.json.response?.message)) ||
              decodeBody(createRes) ||
              'HTTP ' + createRes.statusCode
            $app
              .logger()
              .error(
                'Evolution QR: failed to recreate instance',
                'statusCode',
                createRes.statusCode,
                'response',
                lastError,
              )
          }
        }
      }

      const qrBase64 = extractQr(json)
      const state = json?.instance?.state || json?.instance?.status || ''

      if (qrBase64) {
        instance.set('qrcode', qrBase64)
        instance.set('status', 'connecting')
        $app.saveNoValidate(instance)
      } else if (state === 'open') {
        instance.set('status', 'connected')
        instance.set('qrcode', '')
        $app.saveNoValidate(instance)
      } else if (res.statusCode < 200 || res.statusCode >= 300 || (json && json.error)) {
        $app
          .logger()
          .warn(
            'Evolution QR: connect failed',
            'statusCode',
            res.statusCode,
            'response',
            json ? JSON.stringify(json) : decodeBody(res),
          )
      }
    } catch (err) {
      lastError = String(err)
      $app.logger().error('Evolution QR Error', 'error', lastError)
    }

    const status = instance.getString('status')
    const qrcode = instance.getString('qrcode')

    if (status === 'connected') {
      return e.json(200, { status: 'connected', qrcode: '' })
    }

    // Surface a readable error instead of an empty QR forever
    if (!qrcode) {
      return e.internalServerError(
        'Não foi possível gerar o QR Code: a Evolution API não retornou um código de pareamento' +
          (lastError ? ' (' + lastError + ').' : '. Verifique a instância e tente novamente.'),
      )
    }

    return e.json(200, { status: status, qrcode: qrcode })
  },
  $apis.requireAuth(),
)
