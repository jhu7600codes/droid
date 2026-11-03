package com.droid.hellojni;

import android.app.Activity;
import android.os.Bundle;
import android.widget.TextView;

public class SecondActivity extends Activity {
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        setContentView(R.layout.second);
        int count = getIntent().getIntExtra("count", -1);
        ((TextView) findViewById(R.id.msg)).setText("Second activity, count was " + count + ". Press back.");
    }
}
