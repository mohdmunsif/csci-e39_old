import http from 'http'
import debug from 'debug'
import Koa from 'koa'
import cors from 'koa-cors'
import logger from 'koa-logger'
import route from 'koa-route'
import serve from 'koa-static'
import views from 'koa-views'
import React from 'react'
import ReactDOMServer from 'react-dom/server'
import socketio from 'socket.io'
import config from './config'
import {Student, Message} from './db'
import upload from './services/upload'
import App from './ui/app.jsx'
import {IMAGE_MIMES, KB} from './util/constants'

const log = debug(`csci-e39:server`)

const g = {
	chat: {
		typing: [],
	},
}

/* ------------------------------- ENDPOINTS ------------------------------- */

const app = new Koa()

if (config.env !== `test`) app.use(logger())

app.use(cors({origin: `*`}))

app.use(serve(`public`))

app.use(views(`${__dirname}/ui`, {extension: `pug`}))

app.use(route.get(`/`, async ctx => {
	await ctx.render(`index`, {
		app: renderApp({auth: {status: `init`, message: ``}}),
	})
}))

/* -------------------------------- SERVER --------------------------------- */

const server = http.createServer(app.callback())

const io = socketio(server)

io.use((socket, next) => (socket.ctx = {}) && next())

io.use(authenticate)

io.on(`connection`, async socket => {
	const {student} = socket.ctx
	if (!student) socket.disconnect()

	socket.emit(`student:join`, student.toJSON())

	socket.on(`disconnect`, () => {
		socket.broadcast.emit(`student:leave`, student.toJSON())
	})

	socket.on(`register`, async () => {
		const {student} = socket.ctx
		try {
			if (!!student.get(`confirmed_at`)) return socket.emit(`register:failure`, {message: `This ID has already been used`})

			const updatedStudent = await student.save({confirmed_at: new Date()}, {patch: true})
			if (!updatedStudent) return socket.emit(`register:failure`, {message: `Failed to register you - please try again`})

			socket.emit(`register:success`, {message: `${student.get(`name`)} registered!`})
		} catch (e) {
			log(e)
			socket.emit(`register:failure`, {message: `Unexpected failure - please try again`})
		}
	})

	socket.on(`upload:chunk`, (file, chunk) => {
		const {student} = socket.ctx
		try {
			if (file.size > 500 * KB) return socket.emit(`upload:failure`, file, {message: `Max file size 500KB`})
			if (!IMAGE_MIMES.includes(file.type)) return socket.emit(`upload:failure`, file, {message: `File must be an image`})

			const uploaded = upload(file, chunk, finish)
			return socket.emit(`upload:request-chunk`, file, uploaded)
		} catch(e) {
			log(e)
			return socket.emit(`upload:failure`, file, {message: `Unexpected failure - please try again`})
		}

		async function finish(url) {
			try {
				const {name, description} = file
				await student.related(`uploads`).create({url, name, description})
				return socket.emit(`upload:success`, file, url)
			} catch (e) {
				log(e)
				return socket.emit(`upload:failure`, file, {message: `Unexpected failure - please try again`})
			}
		}
	})

	socket.join(`chat`)

	socket.on(`chat:typing:start`, () => {
		g.chat.typing.push(student)
		socket.in(`chat`).broadcast.emit(`chat:typing`, g.chat.typing)
	})

	socket.on(`chat:typing:stop`, () => {
		g.chat.typing = g.chat.typing.filter(({id}) => id !== student.id)
		socket.in(`chat`).broadcast.emit(`chat:typing`, g.chat.typing)
	})

	socket.on(`chat:message`, async ({id, text}) => {
		try {
			const newMessage = await student.related(`messages`).create({unique_id: id, text})
			const message = await newMessage.refresh({withRelated: [`student`]})
			socket.emit(`chat:message:success`, {message: `Message sent`})
			io.in(`chat`).emit(`chat:message`, message.toJSON())
		} catch (e) {
			log(e)
			socket.emit(`chat:message:failure`, {message: `Unexpected failure - please try again`})
		}
	})

	// SEND INITIAL DATA

	const messages = await Message
		.query(qb => qb.limit(30))
		.orderBy(`-created_at`)
		.fetchAll({withRelated: [`student`]})
	socket.emit(`chat:messages`, messages.toJSON())

})

server.listen(config.port, () => log(`listening at localhost:${config.port}`))

/* -------------------------------- HELPERS -------------------------------- */

function renderApp(props) {
	return ReactDOMServer.renderToString(<App {...props} />)
}

async function authenticate(socket, next) {
	const fail = message => next(new AuthError(message))

	try {
		const {studentId} = socket.handshake.query

		if (studentId === `id-not-set`) return fail(`.id file must exist`)

		socket.ctx.student = await Student.where(`unique_id`, studentId).fetch()
		if (!socket.ctx.student) return fail(`Student ID does not exist`)

		socket.emit(`auth.success`)
		return next()
	} catch (e) {
		log(e)
		return fail(`Unexpected failure - please try again`)
	}
}

class SocketError extends Error {
	constructor(type, message) {
		super(message)
		this.data = [type, {message}]
	}
}

class AuthError extends SocketError {
	constructor(message) {
		super(`auth:failure`, message)
	}
}