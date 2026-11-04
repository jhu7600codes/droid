package com.droid.kt

import android.app.Activity
import android.media.MediaPlayer
import android.os.Bundle
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.ListView
import android.widget.TextView
import android.widget.Toast

data class Pigeon(val name: String, val age: Int) {
    fun describe() = "$name ($age)"
}

object Flock {
    val names = listOf("Gray", "Blue", "Danen", "Pip", "Coo")
    fun next(n: Int) = Pigeon(names[n % names.size], n % 7 + 1)
}

fun Int.squared() = this * this

class MainActivity : Activity() {
    private lateinit var adapter: ArrayAdapter<String>
    private val pigeons = mutableListOf<Pigeon>()
    private var player: MediaPlayer? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.main)
        val nums = (1..10).toList()
        val evens = nums.filter { it % 2 == 0 }.map { it.squared() }
        val total = evens.sum()
        val label: String? = intent?.getStringExtra("label")
        val kind = when {
            total > 200 -> "big"
            total > 100 -> "medium"
            else -> "small"
        }
        (findViewById(R.id.info) as TextView).text = "kotlin on droid\nevens squared: ${evens.joinToString()}\nsum $total is $kind, label ${label ?: "none"}\n${Pigeon("Gray", 3)}"
        adapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, mutableListOf<String>())
        (findViewById(R.id.list) as ListView).adapter = adapter
        (findViewById(R.id.add) as Button).setOnClickListener {
            val p = Flock.next(pigeons.size)
            pigeons += p
            adapter.add(p.describe())
            Toast.makeText(this, "${pigeons.size} pigeons, oldest ${pigeons.maxByOrNull { it.age }?.name}", Toast.LENGTH_SHORT).show()
        }
        (findViewById(R.id.play) as Button).setOnClickListener {
            player?.release()
            player = MediaPlayer.create(this, R.raw.beep).apply {
                setOnCompletionListener { Toast.makeText(this@MainActivity, "sound done", Toast.LENGTH_SHORT).show() }
                start()
            }
        }
    }

    override fun onPause() {
        super.onPause()
        player?.pause()
    }
}
